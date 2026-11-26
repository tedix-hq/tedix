import { advancePlatformCronCheckpoint } from "./platform-cron-executions";
import type { WorkInteraction } from "../schema/work-factory";
import type { TediApprovalRequest } from "../schema/approvals";
import type { WorkItem } from "../schema/work-items";
import {
	and,
	asc,
	desc,
	eq,
	getColumns,
	gt,
	gte,
	inArray,
	lte,
	sql,
	type SQL,
} from "drizzle-orm";
import { coreTable } from "../core-store/client";
import {
	booleanValue,
	coreStore,
	jsonRead,
	jsonWrite,
} from "../core-store/dialect";
import {
	decisionExposures,
	decisionOutcomeLabels,
	learningInteractionEvents,
} from "../schema/learning-feedback";
import {
	workInteractions,
	workInteractionStoredColumns,
	workInteractionResponses,
	workApprovalProposals,
	workApprovalDecisions,
} from "../schema/work-factory";
import { workItems, workItemStoredColumns } from "../schema/work-items";
import {
	tediApprovalRequests,
	approvalRequestStoredColumns,
} from "../schema/approvals";
import { memoryFacts } from "../schema/memory-graph";
import {
	DecisionLearningConfigSchema,
	type DecisionLearningConfig,
} from "@tedix/api-contract/schemas/decision-learning";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { platformCronCheckpoints } from "../schema/platform-cron-executions";
import { chunkForBoundParams } from "../utils/batch";

export async function getDecisionLearningConfig(
	db: DbQueryClient,
	organizationId: string,
) {
	const orgs = coreTable(db, organizations);
	const [row] = await db
		.select({ metadata: orgs.metadata })
		.from(orgs)
		.where(eq(orgs.id, organizationId))
		.limit(1);
	return DecisionLearningConfigSchema.parse(
		row?.metadata?.decisionLearning ?? {},
	);
}
export async function setDecisionLearningConfig(
	db: DbQueryClient,
	organizationId: string,
	config: DecisionLearningConfig,
) {
	const parsed = DecisionLearningConfigSchema.parse(config);
	const orgs = coreTable(db, organizations);
	await db
		.update(orgs)
		.set({
			metadata: jsonWrite(db, orgs.metadata, ["decisionLearning"], parsed),
		})
		.where(eq(orgs.id, organizationId));
	return parsed;
}

/** Every caller-supplied id is tenant and recipient fenced, including alternatives. */
export async function listDecisionInstrumentationSources(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardIds: string[];
		mayReadApprovals: boolean;
	},
) {
	const interactions: WorkInteraction[] = [];
	const proposals: (typeof workApprovalProposals.$inferSelect)[] = [];
	const approvals: TediApprovalRequest[] = [];
	const postgres = coreStore(db) === "postgres";
	const cards = coreTable(db, workInteractions);
	const proposalRows = coreTable(db, workApprovalProposals);
	const approvalRows = coreTable(db, tediApprovalRequests);
	const itemsTable = coreTable(db, workItems);
	for (let offset = 0; offset < p.cardIds.length; offset += 50) {
		const ids = p.cardIds.slice(offset, offset + 50);
		interactions.push(
			...(await db
				.select(postgres ? getColumns(cards) : workInteractionStoredColumns)
				.from(cards)
				.where(
					and(
						eq(cards.orgId, p.organizationId),
						eq(cards.targetType, "user"),
						eq(cards.targetId, p.actorId),
						inArray(cards.id, ids),
					),
				)),
		);
		proposals.push(
			...(await db
				.select()
				.from(proposalRows)
				.where(
					and(
						eq(proposalRows.orgId, p.organizationId),
						eq(proposalRows.approverType, "user"),
						eq(proposalRows.approverId, p.actorId),
						inArray(
							proposalRows.id,
							ids
								.filter((id) => id.startsWith("work-approval:"))
								.map((id) => id.slice(14)),
						),
					),
				)),
		);
		if (p.mayReadApprovals)
			approvals.push(
				...(await db
					.select(
						postgres ? getColumns(approvalRows) : approvalRequestStoredColumns,
					)
					.from(approvalRows)
					.where(
						and(
							eq(approvalRows.orgId, p.organizationId),
							inArray(
								approvalRows.id,
								ids
									.filter((id) => id.startsWith("approval:"))
									.map((id) => id.slice(9)),
							),
						),
					)),
			);
	}
	const items: WorkItem[] = [];
	for (const ids of chunkForBoundParams(
		[
			...new Set([
				...interactions.flatMap((r) => (r.workItemId ? [r.workItemId] : [])),
				...proposals.map((r) => r.workItemId),
			]),
		],
		50,
	)) {
		items.push(
			...(await db
				.select(postgres ? getColumns(itemsTable) : workItemStoredColumns)
				.from(itemsTable)
				.where(
					and(
						eq(itemsTable.orgId, p.organizationId),
						inArray(itemsTable.id, ids),
					),
				)),
		);
	}
	return { interactions, proposals, approvals, items };
}

export async function insertDecisionExposure(
	db: DbQueryClient,
	row: typeof decisionExposures.$inferInsert,
) {
	const exposures = coreTable(db, decisionExposures);
	await db.insert(exposures).values(row).onConflictDoNothing();
	return db
		.select()
		.from(exposures)
		.where(
			and(
				eq(exposures.organizationId, row.organizationId),
				eq(exposures.actorId, row.actorId),
				eq(exposures.id, row.id),
			),
		)
		.limit(1);
}

export async function listDecisionInstrumentation(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardId?: string;
		classId?: string;
		now: string;
		limit: number;
	},
) {
	const exposures = coreTable(db, decisionExposures);
	const labels = coreTable(db, decisionOutcomeLabels);
	const scope = and(
		// This tautology offers the ordered index only to the list, preserving
		// receipt lookups through the narrower tenant/person/card index.
		coreStore(db) === "d1"
			? sql`+${exposures.occurredAt} >= ''`
			: sql`${exposures.occurredAt} >= ''`,
		eq(exposures.organizationId, p.organizationId),
		eq(exposures.actorId, p.actorId),
		gt(exposures.expiresAt, p.now),
		p.cardId ? eq(exposures.cardId, p.cardId) : undefined,
		p.classId ? eq(exposures.classId, p.classId) : undefined,
	);
	const exposureRows = await db
		.select()
		.from(exposures)
		.where(scope)
		.orderBy(desc(exposures.occurredAt), asc(exposures.id))
		.limit(p.limit);
	const labelRows = await db
		.select()
		.from(labels)
		.where(
			and(
				eq(labels.organizationId, p.organizationId),
				eq(labels.actorId, p.actorId),
				gt(labels.expiresAt, p.now),
				p.cardId ? eq(labels.cardId, p.cardId) : undefined,
				p.classId ? eq(labels.classId, p.classId) : undefined,
			),
		)
		.orderBy(desc(labels.observedAt), asc(labels.id))
		.limit(p.limit * 3);
	return { exposures: exposureRows, labels: labelRows };
}

const LABEL_SCAN_CHECKPOINT = "decision-outcome-labeller:";
export type DecisionLabelScanSource = "responses" | "approvals";

/** Latest scheduled time through which this source's receipts were all examined. */
export async function getDecisionLabelScanCheckpoint(
	db: DbQueryClient,
	source: DecisionLabelScanSource | `${DecisionLabelScanSource}:sweep`,
) {
	const checkpoints = coreTable(db, platformCronCheckpoints);
	const [row] = await db
		.select({ through: checkpoints.through })
		.from(checkpoints)
		.where(eq(checkpoints.scheduleId, LABEL_SCAN_CHECKPOINT + source))
		.limit(1);
	return row?.through ?? null;
}
/** Compare-and-set progress; a delayed duplicate tick cannot rewind a newer checkpoint. */
export async function advanceDecisionLabelScanCheckpoint(
	db: DbQueryClient,
	source: DecisionLabelScanSource | `${DecisionLabelScanSource}:sweep`,
	previous: string | null,
	next: string,
) {
	await advancePlatformCronCheckpoint(db, {
		scheduleId: LABEL_SCAN_CHECKPOINT + source,
		through: next,
		mode: "cas",
		previous,
	});
}

export interface DecisionReceiptRange {
	afterRowid: number;
	throughRowid: number;
}

/** A backstop page bounds input receipts, including already-labelled history. */
export async function beginDecisionLabelSweep(
	db: DbQueryClient,
	source: DecisionLabelScanSource,
	at: string,
) {
	const previous = await getDecisionLabelScanCheckpoint(db, `${source}:sweep`);
	const state: { afterRowid: number; completedAt: string | null } = previous
		? JSON.parse(previous)
		: { afterRowid: 0, completedAt: null };
	if (
		state.completedAt &&
		Date.parse(at) - Date.parse(state.completedAt) < 86_400_000
	)
		return null;
	const responses = coreTable(db, workInteractionResponses);
	const decisions = coreTable(db, workApprovalDecisions);
	const requests = coreTable(db, tediApprovalRequests);
	// D1 uses rowids; Postgres uses the identity sequence column.
	const postgres = coreStore(db) === "postgres";
	const position = (
		table:
			| typeof workInteractionResponses
			| typeof workApprovalDecisions
			| typeof tediApprovalRequests,
	) => (postgres ? sql`${table}.sequence` : sql`${table}.rowid`);
	const headOf = (
		table:
			| typeof workInteractionResponses
			| typeof workApprovalDecisions
			| typeof tediApprovalRequests,
	) =>
		db
			.select({
				rowid: sql<number>`coalesce(max(${position(table)}), 0)`
					.mapWith(Number)
					.as("rowid"),
			})
			.from(table);
	const heads =
		source === "responses"
			? await headOf(responses)
			: await headOf(decisions).unionAll(headOf(requests));
	const head = Math.max(0, ...heads.map((row) => Number(row.rowid)));
	const afterRowid =
		state.completedAt || state.afterRowid > head ? 0 : state.afterRowid;
	return {
		source,
		previous,
		head,
		afterRowid,
		// Responses fan out across repeated exposures; keep their input page smaller.
		throughRowid: Math.min(
			head,
			afterRowid + (source === "responses" ? 100 : 1_000),
		),
	};
}

export async function finishDecisionLabelSweep(
	db: DbQueryClient,
	scan: NonNullable<Awaited<ReturnType<typeof beginDecisionLabelSweep>>>,
	at: string,
	rowCount: number,
	limit: number,
) {
	// A full output page may still have unlabelled receipts in the input page.
	if (rowCount >= limit) return;
	const complete = scan.throughRowid === scan.head;
	await advanceDecisionLabelScanCheckpoint(
		db,
		`${scan.source}:sweep`,
		scan.previous,
		JSON.stringify({
			afterRowid: complete ? 0 : scan.throughRowid,
			completedAt: complete ? at : null,
		}),
	);
}

function unlabelledResponseColumns(db: DbQueryClient) {
	const exposures = coreTable(db, decisionExposures);
	const responses = coreTable(db, workInteractionResponses);
	return {
		exposureId: sql<string>`${exposures.id}`.as("exposure_id"),
		organizationId: exposures.organizationId,
		actorId: exposures.actorId,
		cardId: exposures.cardId,
		classId: exposures.classId,
		expiresAt: exposures.expiresAt,
		responseId: sql`${responses.id}`.mapWith(responses.id).as("response_id"),
		respondedAt: sql`${responses.respondedAt}`
			.mapWith(responses.respondedAt)
			.as("responded_at"),
		metadata: sql`${responses.metadata}`
			.mapWith(responses.metadata)
			.as("metadata"),
		responseKind: sql`${responses.responseKind}`
			.mapWith(responses.responseKind)
			.as("response_kind"),
	};
}
function unlabelledResponseOrder(db: DbQueryClient) {
	const exposures = coreTable(db, decisionExposures);
	const responses = coreTable(db, workInteractionResponses);
	return [
		asc(responses.respondedAt),
		asc(responses.id),
		desc(exposures.occurredAt),
		desc(exposures.id),
	];
}
/** The exposure a response answers: same tenant, person, card and request version, shown first. */
function responseAnswersExposure(db: DbQueryClient) {
	const exposures = coreTable(db, decisionExposures);
	const responses = coreTable(db, workInteractionResponses);
	return and(
		eq(responses.orgId, exposures.organizationId),
		eq(responses.interactionId, exposures.cardId),
		eq(responses.responderId, exposures.actorId),
		eq(responses.responderType, "user"),
		sql`${responses.respondedAt} >= ${exposures.occurredAt}`,
		// The response stores the post-save version; the exposure saw the prior request.
		sql`${jsonRead(db, exposures.context, ["sourceVersion"], "number")} + 1 = ${responses.resolvedRequestVersion}`,
	);
}
function unlabelledUnexpiredResponse(db: DbQueryClient, now: string) {
	const exposures = coreTable(db, decisionExposures);
	const responses = coreTable(db, workInteractionResponses);
	return and(
		gt(exposures.expiresAt, now),
		sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.organization_id=${exposures.organizationId} AND l.actor_id=${exposures.actorId} AND l.id=(${exposures.organizationId} || ':' || ${responses.id} || ':immediate'))`,
	);
}

/**
 * Responses that answer an unexpired exposure and have no immediate label yet,
 * oldest first. Labelled receipts are excluded in SQL, so undecided cards
 * cannot starve the page.
 *
 * Without `respondedFrom` this is the complete sweep: it reads every unexpired
 * exposure. With it, only responses at or after that time are read, through
 * the response time index, and each looks its exposures up by tenant, person
 * and card. A `range` instead seeks a bounded historical receipt page in rowid
 * order. The caller owns the checkpoint that makes the bounded read safe.
 */
export async function listUnlabelledDecisionResponses(
	db: DbQueryClient,
	now: string,
	limit = 50,
	respondedFrom: string | null = null,
	range?: DecisionReceiptRange,
) {
	const postgres = coreStore(db) === "postgres";
	const exposures = coreTable(db, decisionExposures);
	const responses = coreTable(db, workInteractionResponses);
	// D1 uses rowids; Postgres uses the identity sequence column.
	const position = postgres
		? sql`${responses}.sequence`
		: sql`${responses}.rowid`;
	if (respondedFrom === null && !range)
		return db
			.select(unlabelledResponseColumns(db))
			.from(exposures)
			.innerJoin(responses, responseAnswersExposure(db))
			.where(unlabelledUnexpiredResponse(db, now))
			.orderBy(...unlabelledResponseOrder(db))
			.limit(limit);
	// CROSS JOIN fixes the loop order: the recent responses drive the exposure
	// lookup. Pin the time index too: live statistics can prefer scanning the
	// tenant/card index to satisfy the join, even with a recent-time predicate.
	return db
		.select(unlabelledResponseColumns(db))
		.from(
			postgres
				? responses
				: range
					? responses
					: sql`${responses} INDEXED BY idx_work_interaction_responses_time`,
		)
		.crossJoin(exposures)
		.where(
			and(
				respondedFrom === null
					? undefined
					: gte(responses.respondedAt, respondedFrom),
				range
					? sql`${position} > ${range.afterRowid} AND ${position} <= ${range.throughRowid}`
					: undefined,
				responseAnswersExposure(db),
				unlabelledUnexpiredResponse(db, now),
			),
		)
		.orderBy(
			...(range
				? [asc(position), desc(exposures.occurredAt), desc(exposures.id)]
				: unlabelledResponseOrder(db)),
		)
		.limit(limit);
}

/**
 * Approval decisions by the person an unexpired exposure was shown to, with
 * no immediate label yet, oldest first; up to `limit` rows from each of the
 * two approval tables.
 *
 * Without `decidedFrom` this is the complete sweep: it walks every Work
 * approval decision and every tedi approval request. With it, both walks start
 * at that time in their time index. The caller owns the checkpoint that makes
 * the bounded read safe. A `range` seeks historical receipts in rowid order.
 */
export async function listUnlabelledDecisionApprovals(
	db: DbQueryClient,
	now: string,
	limit = 50,
	decidedFrom: string | null = null,
	range?: DecisionReceiptRange,
) {
	const postgres = coreStore(db) === "postgres";
	const exposures = coreTable(db, decisionExposures);
	const decisions = coreTable(db, workApprovalDecisions);
	const proposals = coreTable(db, workApprovalProposals);
	const requests = coreTable(db, tediApprovalRequests);
	// D1 uses rowids; Postgres uses the identity sequence column.
	const decisionPosition = postgres
		? sql`${decisions}.sequence`
		: sql`${decisions}.rowid`;
	const requestPosition = postgres
		? sql`${requests}.sequence`
		: sql`${requests}.rowid`;
	const work = await db
		.select({
			exposureId: sql<string>`${exposures.id}`.as("exposure_id"),
			organizationId: exposures.organizationId,
			actorId: exposures.actorId,
			cardId: exposures.cardId,
			classId: exposures.classId,
			expiresAt: exposures.expiresAt,
			receiptId: decisions.id,
			decidedAt: decisions.decidedAt,
			decision: decisions.decision,
		})
		// CROSS JOIN fixes the loop order: decisions in time order, each one's
		// proposal by id, then the exposures of that tenant, person and card.
		// The card id is derived from the proposal id, so starting from the
		// exposures would walk the tenant's proposals once per exposure.
		.from(decisions)
		.crossJoin(proposals)
		.crossJoin(exposures)
		.where(
			and(
				decidedFrom === null
					? undefined
					: gte(decisions.decidedAt, decidedFrom),
				range
					? sql`${decisionPosition} > ${range.afterRowid} AND ${decisionPosition} <= ${range.throughRowid}`
					: undefined,
				eq(decisions.proposalId, proposals.id),
				eq(decisions.deciderType, "user"),
				eq(proposals.orgId, exposures.organizationId),
				eq(decisions.deciderId, exposures.actorId),
				sql`${exposures.cardId} = ('work-approval:' || ${proposals.id})`,
				sql`${decisions.decidedAt}>=${exposures.occurredAt}`,
				gt(exposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.organization_id=${exposures.organizationId} AND l.id=(${exposures.organizationId} || ':' || ${decisions.id} || ':immediate'))`,
			),
		)
		.orderBy(range ? asc(decisionPosition) : asc(decisions.decidedAt))
		.limit(limit);
	const tedi = await db
		.select({
			exposureId: sql<string>`${exposures.id}`.as("exposure_id"),
			organizationId: exposures.organizationId,
			actorId: exposures.actorId,
			cardId: exposures.cardId,
			classId: exposures.classId,
			expiresAt: exposures.expiresAt,
			receiptId: requests.id,
			decidedAt: requests.resolvedAt,
			decision: requests.status,
		})
		// Keep approvals outermost so each receipt probes the exposure's
		// org/actor/card index instead of rescanning approvals per exposure.
		.from(requests)
		.crossJoin(exposures)
		.where(
			and(
				decidedFrom === null
					? undefined
					: gte(requests.resolvedAt, decidedFrom),
				range
					? sql`${requestPosition} > ${range.afterRowid} AND ${requestPosition} <= ${range.throughRowid}`
					: undefined,
				// Correlate the index lookup so SQLite cannot build a Bloom filter
				// by reading every exposure before examining recent approvals.
				postgres
					? and(
							eq(exposures.organizationId, requests.orgId),
							eq(exposures.actorId, requests.resolvedBy),
							sql`${exposures.cardId} = ('approval:' || ${requests.id})`,
						)
					: sql`${exposures}.rowid IN (
						SELECT rowid FROM decision_exposures candidates
						WHERE candidates.organization_id = ${requests.orgId}
						AND candidates.actor_id = ${requests.resolvedBy}
						AND candidates.card_id = ('approval:' || ${requests.id})
					)`,
				inArray(requests.status, ["approved", "rejected"]),
				sql`${requests.resolvedAt}>=${exposures.occurredAt}`,
				gt(exposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.organization_id=${exposures.organizationId} AND l.id=(${exposures.organizationId} || ':' || ${requests.id} || ':immediate'))`,
			),
		)
		.orderBy(range ? asc(requestPosition) : asc(requests.resolvedAt))
		.limit(limit);
	return [...work, ...tedi];
}

export async function insertDecisionOutcomeLabel(
	db: DbQueryClient,
	row: typeof decisionOutcomeLabels.$inferInsert,
) {
	const labels = coreTable(db, decisionOutcomeLabels);
	const inserted = await db
		.insert(labels)
		.values(row)
		.onConflictDoNothing()
		.returning({ id: labels.id });
	return inserted.length > 0;
}
export async function listDueDecisionLabels(
	db: DbQueryClient,
	now: string,
	window: "day_1" | "day_7",
	limit = 50,
) {
	const milliseconds = window === "day_1" ? 86400000 : 604800000;
	const labels = coreTable(db, decisionOutcomeLabels);
	return db
		.select()
		.from(labels)
		.where(
			and(
				eq(labels.window, "immediate"),
				lte(
					labels.dueAt,
					new Date(Date.parse(now) - milliseconds).toISOString(),
				),
				gt(labels.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.id = (${labels.id} || ':' || ${window}))`,
			),
		)
		.orderBy(asc(labels.dueAt), asc(labels.id))
		.limit(limit);
}
/** Text timestamps hold both `YYYY-MM-DD HH:MM:SS` and ISO forms; normalize like SQLite datetime(). */
function decisionTimestamp(db: DbQueryClient, value: SQL) {
	return coreStore(db) === "postgres"
		? sql`CASE WHEN pg_input_is_valid(${value}, 'timestamp with time zone') THEN date_trunc('second', CASE WHEN ${value} ~ '(Z|z|[+-][0-9]{2}:?[0-9]{2})$' THEN ${value}::timestamptz ELSE ${value}::timestamp AT TIME ZONE 'UTC' END) END`
		: sql`datetime(${value})`;
}

export async function getDecisionLabelEvidence(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardId: string;
		receiptId: string;
		exposureId: string;
		decidedAt: string;
		until: string;
	},
) {
	const exposures = coreTable(db, decisionExposures);
	const exposureRows = await db
		.select({ snapshot: exposures.snapshot })
		.from(exposures)
		.where(
			and(
				eq(exposures.organizationId, p.organizationId),
				eq(exposures.actorId, p.actorId),
				eq(exposures.cardId, p.cardId),
				eq(exposures.id, p.exposureId),
				sql`${exposures.occurredAt}<=${p.decidedAt}`,
			),
		)
		.orderBy(desc(exposures.occurredAt))
		.limit(1);
	const workItemId = exposureRows[0]?.snapshot.workItemId;
	const items = coreTable(db, workItems);
	const work = workItemId
		? await db
				.select({
					id: items.id,
					disposition: items.disposition,
					completedAt: items.completedAt,
				})
				.from(items)
				.where(and(eq(items.orgId, p.organizationId), eq(items.id, workItemId)))
				.limit(1)
		: [];
	const events = coreTable(db, learningInteractionEvents);
	const facts = coreTable(db, memoryFacts);
	const interactions = coreTable(db, workInteractions);
	const evidenceIds =
		coreStore(db) === "postgres"
			? sql`jsonb_array_elements_text(${jsonRead(db, facts.metadata, ["learningFeed", "evidenceEventIds"], "json")})`
			: sql`json_each(json_extract(${facts.metadata}, '$.learningFeed.evidenceEventIds'))`;
	const eventRows = await db
		.select({
			id: events.id,
			eventKind: events.eventKind,
			metadata: events.metadata,
		})
		.from(events)
		.where(
			and(
				eq(events.organizationId, p.organizationId),
				sql`(${events.scopeKind} <> 'personal' OR ${events.scopeId}=${p.actorId})`,
				sql`${events.occurredAt}>${p.decidedAt}`,
				lte(events.occurredAt, p.until),
				sql`(${events.targetId}=${p.cardId} OR ${events.targetId}=${workItemId ?? p.cardId} OR (${p.cardId} LIKE 'approval:%' AND ${events.targetId}=substr(${p.cardId},10)) OR ${jsonRead(db, events.metadata, ["correctsEventId"])} IN (SELECT id FROM learning_interaction_events le WHERE le.organization_id=${p.organizationId} AND le.client_event_id=('decision-capture:' || ${p.receiptId})))`,
				sql`${jsonRead(db, events.metadata, ["serverObserved"], "boolean")} = ${booleanValue(db, true)}`,
			),
		)
		.limit(50);
	const lessonRows = await db
		.select({ id: facts.id })
		.from(facts)
		.where(
			and(
				eq(facts.organizationId, p.organizationId),
				sql`(${jsonRead(db, facts.metadata, ["learningFeed", "ownerUserId"])}=${p.actorId} OR (${facts.tediId} IS NULL AND (coalesce(${facts.visibility},'private')<>'private' OR ${jsonRead(db, facts.metadata, ["learningFeed", "ownerUserId"])} IS NULL)))`,
				sql`${decisionTimestamp(db, sql`${facts.createdAt}`)}>${decisionTimestamp(db, sql`${p.decidedAt}`)}`,
				sql`${decisionTimestamp(db, sql`${facts.createdAt}`)}<=${decisionTimestamp(db, sql`${p.until}`)}`,
				sql`EXISTS (SELECT 1 FROM ${evidenceIds} e WHERE e.value IN (SELECT le.id FROM learning_interaction_events le WHERE le.organization_id=${p.organizationId} AND le.target_id=${p.cardId}))`,
			),
		)
		.limit(50);
	const followUps = workItemId
		? await db
				.select({ id: interactions.id })
				.from(interactions)
				.where(
					and(
						eq(interactions.orgId, p.organizationId),
						eq(interactions.targetId, p.actorId),
						eq(interactions.targetType, "user"),
						eq(interactions.workItemId, workItemId),
						sql`${interactions.createdAt}>${p.decidedAt}`,
						lte(interactions.createdAt, p.until),
					),
				)
				.limit(50)
		: [];
	return {
		work: work[0] ?? null,
		events: eventRows,
		lessons: lessonRows,
		followUps,
	};
}

export async function pruneDecisionInstrumentation(
	db: DbQueryClient,
	now: string,
) {
	const labels = coreTable(db, decisionOutcomeLabels);
	const exposures = coreTable(db, decisionExposures);
	await db.batch([
		db.delete(labels).where(lte(labels.expiresAt, now)),
		db.delete(exposures).where(lte(exposures.expiresAt, now)),
	]);
}

/** A deferral is timing feedback, never a negative approval outcome. */
export async function getDecisionDeferralTime(
	db: DbQueryClient,
	p: {
		organizationId: string;
		actorId: string;
		cardId: string;
		before: string;
	},
) {
	const events = coreTable(db, learningInteractionEvents);
	const eventRows = await db
		.select({ at: events.occurredAt })
		.from(events)
		.where(
			and(
				eq(events.organizationId, p.organizationId),
				eq(events.actorId, p.actorId),
				eq(events.targetId, p.cardId),
				eq(events.scopeKind, "personal"),
				eq(events.scopeId, p.actorId),
				sql`${jsonRead(db, events.metadata, ["decisionChoice"])}='later'`,
				lte(events.occurredAt, p.before),
			),
		)
		.orderBy(asc(events.occurredAt))
		.limit(1);
	const responses = coreTable(db, workInteractionResponses);
	const responseRows = await db
		.select({ at: responses.respondedAt })
		.from(responses)
		.where(
			and(
				eq(responses.orgId, p.organizationId),
				eq(responses.interactionId, p.cardId),
				eq(responses.responderId, p.actorId),
				eq(responses.responderType, "user"),
				sql`${jsonRead(db, responses.metadata, ["decisionChoice"])}='later'`,
				sql`${responses.respondedAt}<${p.before}`,
			),
		)
		.orderBy(asc(responses.respondedAt))
		.limit(1);
	return [...eventRows, ...responseRows].map((r) => r.at).sort()[0] ?? null;
}

/** Skip/Later is an authenticated browser report, separately identified from an action receipt. */
export async function listUnlabelledDecisionDeferrals(
	db: DbQueryClient,
	now: string,
	limit = 50,
) {
	const events = coreTable(db, learningInteractionEvents);
	const exposures = coreTable(db, decisionExposures);
	// CROSS JOIN fixes SQLite's loop order: scan feedback once, then look up
	// exposures by org/actor/card instead of rescanning a user's feedback for
	// every exposure. The output limit alone does not bound that join work.
	return db
		.select({
			exposureId: sql<string>`${exposures.id}`.as("exposure_id"),
			organizationId: exposures.organizationId,
			actorId: exposures.actorId,
			cardId: exposures.cardId,
			classId: exposures.classId,
			expiresAt: exposures.expiresAt,
			eventId: events.id,
			occurredAt: events.occurredAt,
		})
		.from(events)
		.crossJoin(exposures)
		.where(
			and(
				eq(events.organizationId, exposures.organizationId),
				eq(events.actorId, exposures.actorId),
				eq(events.scopeKind, "personal"),
				eq(events.scopeId, exposures.actorId),
				eq(events.targetId, exposures.cardId),
				eq(events.surface, "decision_deck"),
				sql`${jsonRead(db, events.metadata, ["decisionChoice"])}='later'`,
				sql`${events.occurredAt}>=${exposures.occurredAt}`,
				gt(exposures.expiresAt, now),
				sql`NOT EXISTS (SELECT 1 FROM decision_outcome_labels l WHERE l.id=(${events.organizationId} || ':' || ${events.id} || ':immediate'))`,
			),
		)
		.orderBy(asc(events.occurredAt), desc(exposures.occurredAt))
		.limit(limit);
}

export async function getDecisionExposure(
	db: DbQueryClient,
	p: { organizationId: string; actorId: string; id: string },
) {
	const exposures = coreTable(db, decisionExposures);
	const [row] = await db
		.select()
		.from(exposures)
		.where(
			and(
				eq(exposures.organizationId, p.organizationId),
				eq(exposures.actorId, p.actorId),
				eq(exposures.id, p.id),
			),
		)
		.limit(1);
	return row ?? null;
}
