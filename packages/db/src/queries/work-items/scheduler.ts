import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { chunkForBoundParams } from "../../utils/batch";
import { capabilityLinks, orgCapabilities } from "../../schema/capabilities";
import {
	workEvidence,
	workItemRelations,
	workItems,
	type WorkItem,
} from "../../schema/work-items";
import {
	workApprovalDecisions,
	workApprovalProposals,
	workBudgetEnvelopes,
	workCaseItems,
	workResourcePools,
	workResourceRequirements,
} from "../../schema/work-factory";
import {
	WorkControlError,
	requireActivePrincipal,
	requireExternalSession,
} from "./factory-validation";
import {
	evaluateWorkAdmissionApprovals,
	evaluateWorkAdmissionEligibility,
	type WorkAdmissionFactKind,
} from "./admission-approval-policy";
import { activePurposeContext } from "./purpose";

export interface ReadyWorkScoreFactors {
	priority: number;
	urgency: number;
	aging: number;
	downstream: number;
	criticalPath: number;
	risk: number;
	cost: number;
	verifierBackpressure: number;
}
export interface ReadyWorkCandidate {
	workItem: WorkItem;
	score: number;
	factors: ReadyWorkScoreFactors;
	readiness: { state: "ready"; reasons: [] };
	graphTruncated: boolean;
	resourceClaims: WorkExecutionResourceClaim[];
}
export interface WorkExecutionResourceClaim {
	poolId: string;
	resourceKey: string;
	allocationMode: "exclusive" | "capacity";
	quantity: number;
	capacity: number;
	reserved: number;
}
export interface WorkExecutionCluster {
	index: number;
	items: ReadyWorkCandidate[];
	resourceKeys: string[];
}
const priorityScore = { critical: 100, high: 70, medium: 40, low: 10 } as const;
const riskPenalty = { low: 0, medium: 5, high: 15, critical: 30 } as const;
const HARD_FACT_LIMIT = 5000;
const CAPABILITY_FACT_LIMIT = 1000;

const DAY_MS = 86_400_000;
/** Urgency ceiling, reached exactly when a live deadline lands on `now`. */
export const URGENCY_PEAK = 50;
/** Residual urgency a long-lapsed deadline keeps forever. */
export const URGENCY_LAPSED_FLOOR = 5;
/** Days over which the lapsed-deadline surplus above the floor halves. */
export const URGENCY_LAPSED_HALF_LIFE_DAYS = 14;
/** Aging-fairness ceiling; reached after 210 days of waiting. */
export const AGING_CEILING = 30;

/**
 * Parse a stored scheduler instant. `due_date` and `deadline` are free text in
 * D1 and production carries values like `immediately`, `today`, or `Friday`.
 * An unparseable value is NOT a date, so it yields `null` — the caller must
 * treat that as "no deadline asserted", never as maximum urgency. The previous
 * code fed `Date.parse` straight into arithmetic, so those rows produced a
 * `NaN` score that both scrambled the sort and failed the `z.number().int()`
 * contract parse on the way out.
 */
export function parseSchedulerInstant(
	value: string | null | undefined,
): number | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/** First parseable of the hard deadline then the preferred due date. */
export function resolveSchedulerDueAt(
	item: Pick<WorkItem, "deadline" | "dueDate">,
): number | null {
	return (
		parseSchedulerInstant(item.deadline) ?? parseSchedulerInstant(item.dueDate)
	);
}

/**
 * Deadline pressure, bounded in both directions.
 *
 * A live deadline ramps from 0 (>=25 days out) to {@link URGENCY_PEAK} on the
 * due instant. Once the deadline lapses the surplus above
 * {@link URGENCY_LAPSED_FLOOR} decays with a
 * {@link URGENCY_LAPSED_HALF_LIFE_DAYS}-day half life: a lapsed deadline is
 * stale evidence about priority, not a permanent claim on rank. The curve is
 * continuous at the due instant, and a long-dead deadline still scores above
 * the 0 of work that asserted no deadline at all, so nothing is hidden — it
 * simply stops outranking live work.
 */
export function computeUrgencyScore(
	dueAtMs: number | null,
	nowMs: number,
): number {
	if (dueAtMs === null || !Number.isFinite(nowMs)) return 0;
	const daysUntilDue = (dueAtMs - nowMs) / DAY_MS;
	if (daysUntilDue >= 0) return Math.max(0, URGENCY_PEAK - daysUntilDue * 2);
	return (
		URGENCY_LAPSED_FLOOR +
		(URGENCY_PEAK - URGENCY_LAPSED_FLOOR) *
			2 ** (daysUntilDue / URGENCY_LAPSED_HALF_LIFE_DAYS)
	);
}

/** Bounded anti-starvation credit for how long work has waited. */
export function computeAgingScore(
	createdAtMs: number | null,
	nowMs: number,
): number {
	if (createdAtMs === null || !Number.isFinite(nowMs)) return 0;
	return Math.min(
		AGING_CEILING,
		Math.max(0, (nowMs - createdAtMs) / DAY_MS) / 7,
	);
}

export function boundSchedulerFactChunks<T>(
	chunks: readonly (readonly T[])[],
	cap: number,
): { rows: T[]; truncated: boolean } {
	const chunkTruncated = chunks.some((chunk) => chunk.length > cap);
	const globallyBounded = chunks
		.flatMap((chunk) => chunk.slice(0, cap))
		.slice(0, cap + 1);
	return {
		rows: globallyBounded.slice(0, cap),
		truncated: chunkTruncated || globallyBounded.length > cap,
	};
}

/**
 * Pack ranked, admission-eligible work into sequential execution waves.
 * Items inside one wave are mutually compatible against the observed remaining
 * pool capacity. Waves are advisory: every start still re-runs admission.
 */
export function planExecutionClusters(
	candidates: readonly ReadyWorkCandidate[],
	maxParallelism: number,
): WorkExecutionCluster[] {
	const boundedParallelism = Math.max(1, Math.min(maxParallelism, 50));
	const clusters: Array<WorkExecutionCluster & { usage: Map<string, number> }> =
		[];
	for (const candidate of candidates) {
		let selected = clusters.find((cluster) => {
			if (cluster.items.length >= boundedParallelism) return false;
			return candidate.resourceClaims.every((claim) => {
				const used = cluster.usage.get(claim.poolId) ?? 0;
				if (claim.allocationMode === "exclusive") return used === 0;
				return claim.reserved + used + claim.quantity <= claim.capacity;
			});
		});
		if (!selected) {
			selected = {
				index: clusters.length + 1,
				items: [],
				resourceKeys: [],
				usage: new Map(),
			};
			clusters.push(selected);
		}
		selected.items.push(candidate);
		for (const claim of candidate.resourceClaims) {
			selected.usage.set(
				claim.poolId,
				(selected.usage.get(claim.poolId) ?? 0) + claim.quantity,
			);
			if (!selected.resourceKeys.includes(claim.resourceKey))
				selected.resourceKeys.push(claim.resourceKey);
		}
		selected.resourceKeys.sort();
	}
	return clusters.map(({ usage: _usage, ...cluster }) => cluster);
}

export async function listReadyWork(
	db: DbQueryClient,
	p: {
		orgId: string;
		executorType: "tedi" | "external_agent";
		executorId: string;
		executorSessionId?: string;
		externalSessionKey?: string;
		now: string;
		cursor?: string;
		limit?: number;
		candidateLimit?: number;
		maxCostMicros?: number;
	},
) {
	await requireActivePrincipal(db, {
		orgId: p.orgId,
		type: p.executorType,
		id: p.executorId,
	});
	if (p.executorType === "external_agent") {
		if (!p.executorSessionId || !p.externalSessionKey)
			throw new Error(
				"External scheduler identity requires exact session fence",
			);
		await requireExternalSession(db, {
			orgId: p.orgId,
			principalId: p.executorId,
			sessionId: p.executorSessionId,
			externalSessionKey: p.externalSessionKey,
		});
	}
	const candidateLimit = Math.min(p.candidateLimit ?? 500, 500),
		edgeLimit = Math.min(candidateLimit * 10, 5000);
	const emptyReasons = {
		not_accepted: 0,
		already_running: 0,
		already_admitted: 0,
		purpose_blocked: 0,
		dependencies_blocked: 0,
		capability_blocked: 0,
		approval_blocked: 0,
		budget_blocked: 0,
		resource_blocked: 0,
		evaluation_required: 0,
		coordination_parent: 0,
		cost_blocked: 0,
	};
	const candidates = await db
		.select()
		.from(workItems)
		.where(
			and(
				eq(workItems.orgId, p.orgId),
				eq(workItems.disposition, "accepted"),
				activePurposeContext(p.now),
				sql`NOT EXISTS (SELECT 1 FROM work_attempts active_attempt WHERE active_attempt.org_id=${p.orgId} AND active_attempt.work_item_id=${workItems.id} AND active_attempt.runtime_state IN ('queued','running','waiting','retrying') AND active_attempt.expires_at>${p.now})`,
			),
		)
		.orderBy(
			asc(sql`${workItems.deadline} IS NULL`),
			asc(workItems.deadline),
			desc(
				sql`CASE ${workItems.priority} WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`,
			),
			asc(workItems.createdAt),
			asc(workItems.id),
		)
		.limit(candidateLimit);
	if (!candidates.length) {
		if (p.cursor)
			throw new WorkControlError(
				"NOT_FOUND",
				"Scheduler cursor is outside the bounded ready set",
			);
		return {
			data: [] as ReadyWorkCandidate[],
			nextCursor: null,
			observedAt: p.now,
			evaluatedCandidates: 0,
			ineligibleByReason: emptyReasons,
			boundedCandidateLimit: candidateLimit,
			graphTruncated: false,
			factsTruncated: false,
			truncatedFacts: [] as WorkAdmissionFactKind[],
		};
	}
	const ids = candidates.map((x) => x.id),
		idChunks = chunkForBoundParams(ids, 40);
	const [
		blockerFacts,
		graphEdges,
		capabilityFacts,
		approvalFacts,
		resourceFacts,
		budgetFacts,
		caseFacts,
		pendingEvidence,
	] = await Promise.all([
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select({
						dependentId: workItemRelations.toWorkItemId,
						blockerId: workItemRelations.fromWorkItemId,
						disposition: workItems.disposition,
					})
					.from(workItemRelations)
					.innerJoin(
						workItems,
						eq(workItems.id, workItemRelations.fromWorkItemId),
					)
					.where(
						and(
							eq(workItemRelations.orgId, p.orgId),
							eq(workItemRelations.relationType, "blocks"),
							inArray(workItemRelations.toWorkItemId, idsChunk),
							ne(workItems.disposition, "completed"),
							ne(workItems.disposition, "cancelled"),
						),
					)
					.limit(edgeLimit + 1),
			),
		).then((rows) => boundSchedulerFactChunks(rows, edgeLimit)),
		Promise.all(
			idChunks.flatMap((fromChunk) =>
				idChunks.map((toChunk) =>
					db
						.select({
							from: workItemRelations.fromWorkItemId,
							to: workItemRelations.toWorkItemId,
						})
						.from(workItemRelations)
						.where(
							and(
								eq(workItemRelations.orgId, p.orgId),
								eq(workItemRelations.relationType, "blocks"),
								inArray(workItemRelations.fromWorkItemId, fromChunk),
								inArray(workItemRelations.toWorkItemId, toChunk),
							),
						)
						.limit(edgeLimit + 1),
				),
			),
		).then((rows) => rows.flat().slice(0, edgeLimit + 1)),
		db
			.select({ slug: orgCapabilities.slug, id: orgCapabilities.id })
			.from(capabilityLinks)
			.innerJoin(
				orgCapabilities,
				and(
					eq(orgCapabilities.id, capabilityLinks.capabilityId),
					eq(orgCapabilities.organizationId, p.orgId),
					eq(orgCapabilities.status, "active"),
				),
			)
			.where(
				and(
					eq(capabilityLinks.organizationId, p.orgId),
					eq(capabilityLinks.entityKind, p.executorType),
					eq(capabilityLinks.entityId, p.executorId),
				),
			)
			.limit(CAPABILITY_FACT_LIMIT + 1)
			.then((rows) => boundSchedulerFactChunks([rows], CAPABILITY_FACT_LIMIT)),
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select({
						workItemId: workApprovalProposals.workItemId,
						workItemVersion: workApprovalProposals.workItemVersion,
						authorityKey: workApprovalProposals.authorityKey,
						action: workApprovalProposals.action,
					})
					.from(workApprovalProposals)
					.innerJoin(
						workApprovalDecisions,
						and(
							eq(workApprovalDecisions.proposalId, workApprovalProposals.id),
							eq(workApprovalDecisions.decision, "approved"),
							eq(
								workApprovalDecisions.resolvedProposalVersion,
								workApprovalProposals.version,
							),
						),
					)
					.where(
						and(
							eq(workApprovalProposals.orgId, p.orgId),
							inArray(workApprovalProposals.workItemId, idsChunk),
							eq(workApprovalProposals.status, "approved"),
							sql`${workApprovalProposals.expiresAt}>${p.now}`,
						),
					)
					.limit(HARD_FACT_LIMIT + 1),
			),
		).then((rows) => boundSchedulerFactChunks(rows, HARD_FACT_LIMIT)),
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select({
						workItemId: workResourceRequirements.workItemId,
						resourceKey: workResourceRequirements.resourceKey,
						quantity: workResourceRequirements.quantity,
						poolId: workResourcePools.id,
						allocationMode: workResourcePools.allocationMode,
						capacity: workResourcePools.capacity,
						reserved:
							sql<number>`COALESCE((SELECT SUM(r.quantity) FROM work_resource_reservations r WHERE r.org_id=${p.orgId} AND r.pool_id="work_resource_pools"."id" AND r.state='active' AND r.expires_at>${p.now}),0)`.as(
								"reserved",
							),
					})
					.from(workResourceRequirements)
					.leftJoin(
						workResourcePools,
						and(
							eq(workResourcePools.orgId, workResourceRequirements.orgId),
							eq(
								workResourcePools.resourceKey,
								workResourceRequirements.resourceKey,
							),
							eq(workResourcePools.enabled, true),
						),
					)
					.where(
						and(
							eq(workResourceRequirements.orgId, p.orgId),
							inArray(workResourceRequirements.workItemId, idsChunk),
						),
					)
					.limit(HARD_FACT_LIMIT + 1),
			),
		).then((rows) => boundSchedulerFactChunks(rows, HARD_FACT_LIMIT)),
		db
			.select({
				id: workBudgetEnvelopes.id,
				scopeType: workBudgetEnvelopes.scopeType,
				scopeId: workBudgetEnvelopes.scopeId,
				limitMicros: workBudgetEnvelopes.limitMicros,
				reservationMicros: workBudgetEnvelopes.reservationMicros,
				committed:
					sql<number>`COALESCE((SELECT SUM(CASE WHEN r.state='consumed' THEN COALESCE(r.consumed_micros,r.amount_micros) ELSE r.amount_micros END) FROM work_budget_reservations r WHERE r.org_id=${p.orgId} AND r.envelope_id="work_budget_envelopes"."id" AND (r.state='consumed' OR (r.state='active' AND r.expires_at>${p.now}))),0)`.as(
						"committed",
					),
			})
			.from(workBudgetEnvelopes)
			.where(
				and(
					eq(workBudgetEnvelopes.orgId, p.orgId),
					eq(workBudgetEnvelopes.enabled, true),
				),
			)
			.limit(HARD_FACT_LIMIT + 1)
			.then((rows) => boundSchedulerFactChunks([rows], HARD_FACT_LIMIT)),
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select({
						workItemId: workCaseItems.workItemId,
						caseId: workCaseItems.caseId,
					})
					.from(workCaseItems)
					.where(
						and(
							eq(workCaseItems.orgId, p.orgId),
							inArray(workCaseItems.workItemId, idsChunk),
						),
					)
					.limit(HARD_FACT_LIMIT + 1),
			),
		).then((rows) => boundSchedulerFactChunks(rows, HARD_FACT_LIMIT)),
		Promise.all(
			idChunks.map((idsChunk) =>
				db
					.select({
						workItemId: workEvidence.workItemId,
						count: sql<number>`COUNT(*)`.as("count"),
					})
					.from(workEvidence)
					.where(
						and(
							eq(workEvidence.orgId, p.orgId),
							inArray(workEvidence.workItemId, idsChunk),
							eq(workEvidence.disposition, "pending"),
						),
					)
					.groupBy(workEvidence.workItemId)
					.limit(1000),
			),
		).then((rows) => rows.flat().slice(0, 1000)),
	]);
	const blockerRows = blockerFacts.rows;
	const capabilityRows = capabilityFacts.rows;
	const approvalRows = approvalFacts.rows;
	const requirements = resourceFacts.rows;
	const envelopes = budgetFacts.rows;
	const caseLinks = caseFacts.rows;
	const capSet = new Set(capabilityRows.flatMap((x) => [x.id, x.slug]));
	const dependencyFactsTruncated = blockerFacts.truncated;
	const capabilityFactsTruncated = capabilityFacts.truncated;
	const approvalFactsTruncated = approvalFacts.truncated;
	const resourceFactsTruncated = resourceFacts.truncated;
	const budgetFactsTruncated = budgetFacts.truncated;
	const caseFactsTruncated = caseFacts.truncated;
	const factsTruncated =
		dependencyFactsTruncated ||
		capabilityFactsTruncated ||
		approvalFactsTruncated ||
		resourceFactsTruncated ||
		budgetFactsTruncated ||
		caseFactsTruncated;
	const truncatedFacts: WorkAdmissionFactKind[] = [
		...(dependencyFactsTruncated ? (["dependencies"] as const) : []),
		...(capabilityFactsTruncated ? (["capabilities"] as const) : []),
		...(approvalFactsTruncated ? (["approvals"] as const) : []),
		...(resourceFactsTruncated ? (["resources"] as const) : []),
		...(budgetFactsTruncated ? (["budgets"] as const) : []),
		...(caseFactsTruncated ? (["cases"] as const) : []),
	];
	const edgeTruncated = graphEdges.length > edgeLimit;
	const edges = graphEdges.slice(0, edgeLimit),
		walkLimit = Math.max(candidateLimit * 2, 1);
	const downstream = (root: string) => {
		const seen = new Set<string>(),
			queue = [root];
		while (queue.length && seen.size < walkLimit) {
			const n = queue.shift()!;
			for (const e of edges)
				if (e.from === n && !seen.has(e.to)) {
					seen.add(e.to);
					queue.push(e.to);
				}
		}
		return { count: seen.size, truncated: queue.length > 0 };
	};
	const criticalPath = (root: string) => {
		let max = 0,
			truncated = false;
		const queue: [string, number, Set<string>][] = [[root, 0, new Set([root])]];
		let visited = 0;
		while (queue.length && visited < walkLimit) {
			const [n, d, path] = queue.shift()!;
			visited++;
			max = Math.max(max, d);
			for (const e of edges)
				if (e.from === n && !path.has(e.to)) {
					const next = new Set(path);
					next.add(e.to);
					queue.push([e.to, d + 1, next]);
				}
		}
		if (queue.length) truncated = true;
		return { length: max, truncated };
	};
	const nowMs = Date.parse(p.now);
	const ineligibleByReason: Record<string, number> = { ...emptyReasons };
	const reject = (reason: string) => {
		ineligibleByReason[reason] = (ineligibleByReason[reason] ?? 0) + 1;
	};
	const ready: ReadyWorkCandidate[] = [];
	for (const item of candidates) {
		const itemReqs = requirements.filter((x) => x.workItemId === item.id);
		const cases = new Set(
			caseLinks.filter((x) => x.workItemId === item.id).map((x) => x.caseId),
		);
		const applicable = envelopes.filter(
			(x) =>
				(x.scopeType === "organization" && x.scopeId === p.orgId) ||
				(x.scopeType === "work_item" && x.scopeId === item.id) ||
				(x.scopeType === "project" && x.scopeId === item.projectId) ||
				(x.scopeType === "case" && cases.has(x.scopeId)),
		);
		const blockedResource = itemReqs.find(
			(x) =>
				!x.poolId ||
				x.capacity === null ||
				x.reserved + x.quantity > x.capacity,
		);
		const eligibility = evaluateWorkAdmissionEligibility(item, {
			purposeActive: true,
			activeAttemptId: null,
			blockingDependencyId:
				blockerRows.find((x) => x.dependentId === item.id)?.blockerId ?? null,
			missingCapability:
				item.requiredCapabilities.find((x) => !capSet.has(x)) ?? null,
			approval: evaluateWorkAdmissionApprovals(item, approvalRows),
			blockedResourceKey: blockedResource?.resourceKey ?? null,
			budgetBlocked: applicable.some(
				(x) => x.committed + x.reservationMicros > x.limitMicros,
			),
			truncatedFacts,
		});
		if (!eligibility.eligible) {
			reject(eligibility.blocker!);
			continue;
		}
		const actualCostMicros = Math.max(
			0,
			...applicable.map((x) => x.reservationMicros),
		);
		if (p.maxCostMicros !== undefined && actualCostMicros > p.maxCostMicros) {
			reject("cost_blocked");
			continue;
		}
		const urgency = computeUrgencyScore(resolveSchedulerDueAt(item), nowMs);
		const aging = computeAgingScore(
			parseSchedulerInstant(item.createdAt),
			nowMs,
		);
		const down = downstream(item.id),
			critical = criticalPath(item.id);
		const cost = Math.min(30, actualCostMicros / 1_000_000);
		const verifier =
			pendingEvidence.find((x) => x.workItemId === item.id)?.count ?? 0;
		const factors = {
			priority: priorityScore[item.priority],
			urgency,
			aging,
			downstream: Math.min(50, down.count * 2),
			criticalPath: Math.min(40, critical.length * 5),
			risk: -riskPenalty[item.riskLevel],
			cost: -cost,
			verifierBackpressure: -Math.min(40, verifier * 10),
		};
		// Every factor is bounded and finite by construction; assert it so a future
		// unparsed input can never reach the contract as a NaN score again.
		const summed = Object.values(factors).reduce((a, b) => a + b, 0);
		const score = Number.isFinite(summed) ? summed : 0;
		ready.push({
			workItem: item,
			score,
			factors,
			readiness: { state: "ready", reasons: [] },
			graphTruncated: edgeTruncated || down.truncated || critical.truncated,
			resourceClaims: itemReqs.map((requirement) => ({
				poolId: requirement.poolId!,
				resourceKey: requirement.resourceKey,
				allocationMode: requirement.allocationMode!,
				quantity: requirement.quantity,
				capacity: requirement.capacity!,
				reserved: requirement.reserved,
			})),
		});
	}
	ready.sort(
		(a, b) => b.score - a.score || a.workItem.id.localeCompare(b.workItem.id),
	);
	const start =
		p.cursor === undefined
			? 0
			: ready.findIndex((x) => x.workItem.id === p.cursor) + 1;
	if (p.cursor !== undefined && start === 0)
		throw new WorkControlError(
			"NOT_FOUND",
			"Scheduler cursor is outside the bounded ready set",
		);
	const limit = Math.min(p.limit ?? 50, 200),
		data = ready.slice(start, start + limit),
		hasMore = start + limit < ready.length;
	return {
		data,
		nextCursor: hasMore ? data.at(-1)!.workItem.id : null,
		observedAt: p.now,
		evaluatedCandidates: candidates.length,
		ineligibleByReason,
		boundedCandidateLimit: candidateLimit,
		graphTruncated: edgeTruncated || ready.some((x) => x.graphTruncated),
		factsTruncated,
		truncatedFacts,
	};
}

export async function listReadyWorkExecutionClusters(
	db: DbQueryClient,
	p: Parameters<typeof listReadyWork>[1] & { maxParallelism?: number },
) {
	const ready = await listReadyWork(db, {
		...p,
		cursor: undefined,
		limit: Math.min(p.limit ?? 100, 100),
		candidateLimit: Math.min(p.candidateLimit ?? 10, 100),
	});
	return {
		...ready,
		clusters: planExecutionClusters(ready.data, p.maxParallelism ?? 8),
		maxParallelism: Math.max(1, Math.min(p.maxParallelism ?? 8, 50)),
	};
}
