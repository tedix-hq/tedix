import { coreTable } from "../../core-store/client";
import {
	anyIds,
	coreStore,
	jsonParameter,
	jsonRead,
} from "../../core-store/dialect";
import { interactionAuditTime } from "./interaction-store";
import { informationalCapture } from "@tedix/api-contract/utils/deck-ask";
import { and, count, desc, eq, gt, sql } from "drizzle-orm";
import {
	DecisionEnvelopeSchema,
	DecisionSourcesSchema,
	type DecisionSource,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import type { DbQueryClient } from "../../query-client";
import { auditEvents as d1AuditEvents } from "../../schema/audit-events";
import {
	tediEmailMessages as d1TediEmailMessages,
	tediEmailThreads as d1TediEmailThreads,
} from "../../schema/tedi-email";
import { creditBudgetCardCurrent } from "./budgets";
import {
	decisionRelevantWorkComment,
	decisionRelevantWorkCommentFields,
} from "./comments";
import {
	workItemComments as d1WorkItemComments,
	workItems as d1WorkItems,
} from "../../schema/work-items";
import { workspaceOutputIndex as d1WorkspaceOutputIndex } from "../../schema/workspace-feed";
import { workInteractions as d1WorkInteractions } from "../../schema/work-factory";

type Request = {
	workItemId?: string | null;
	creatorType?: string;
	creatorId?: string;
	createdAt?: string;
	status: string;
	kind?: string;
	targetType: string | null;
	subject: string;
	prompt: string;
	metadata: Record<string, unknown>;
};
export const DECISION_SOURCE_CHANGED =
	"This card's sources changed or cannot be verified. Ask its agent to check the facts and create a fresh card before deciding.";

/** Read again at both boundaries; a previous display check is never answer authority. */
export async function decisionSourcesCurrent(
	db: DbQueryClient,
	orgId: string,
	request: Request,
	options: { reviewedThrough?: string } = {},
) {
	return (await decisionSourcesReview(db, orgId, request, options)).current;
}

type SourceReview =
	| { current: true }
	| {
			current: false;
			/**
			 * Set when the only change is newer comments on a cited Work: the
			 * person may read the latest and answer through its time.
			 */
			reviewable?: { through: string; note: string };
	  };

/**
 * Cited Work and their comment counts, read once for a page of cards. A card
 * whose cited Work and comment count still match needs no further read; the
 * inbox otherwise ran two or three reads per cited Work for every card
 * (72 D1 queries for one inbox page on 21 Nov 2026).
 */
export type DecisionSourcePrefetch = {
	works: Map<
		string,
		{ disposition: string; version: number; executorId: string | null }
	>;
	commentCounts: Map<string, number>;
	outputs: Map<
		string,
		Pick<typeof d1WorkspaceOutputIndex.$inferSelect, "status" | "revisionId">
	>;
	emailThreads: Map<
		string,
		Pick<
			typeof d1TediEmailThreads.$inferSelect,
			"tediId" | "updatedAt" | "lastMessageAt"
		> & { messageCount: number }
	>;
	workReviews: Map<
		Request,
		Map<string, boolean | { through: string; note: string }>
	>;
};

function citedWorkIds(request: Request): string[] {
	const ids: string[] = [];
	const lane = laneBlockerAsk(request);
	if (lane) ids.push(lane.workItemId);
	const envelope = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	for (const raw of [
		request.metadata.decisionSources,
		envelope.success ? envelope.data.sources : undefined,
	]) {
		if (raw === undefined) continue;
		const sources = DecisionSourcesSchema.safeParse(raw);
		if (!sources.success) continue;
		for (const source of sources.data)
			if (source.kind === "work") ids.push(source.id);
	}
	return ids;
}

export async function prefetchDecisionSources(
	db: DbQueryClient,
	orgId: string,
	requests: Request[],
): Promise<DecisionSourcePrefetch> {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const workItems = coreTable(db, d1WorkItems);
	const ids = [...new Set(requests.flatMap(citedWorkIds))];
	const prefetch: DecisionSourcePrefetch = {
		works: new Map(),
		commentCounts: new Map(),
		workReviews: new Map(),
		outputs: new Map(),
		emailThreads: new Map(),
	};
	if (ids.length) {
		const [works, comments] = await db.batch([
			db
				.select({
					id: workItems.id,
					disposition: workItems.disposition,
					version: workItems.version,
					executorId: workItems.executorId,
				})
				.from(workItems)
				.where(and(eq(workItems.orgId, orgId), anyIds(db, workItems.id, ids))),
			db
				.select({
					workItemId: workItemComments.workItemId,
					comments: count(),
				})
				.from(workItemComments)
				.where(
					and(
						eq(workItemComments.orgId, orgId),
						anyIds(db, workItemComments.workItemId, ids),
					),
				)
				.groupBy(workItemComments.workItemId),
		]);
		for (const work of works) prefetch.works.set(work.id, work);
		for (const id of ids)
			prefetch.commentCounts.set(
				id,
				Number(comments.find((row) => row.workItemId === id)?.comments ?? 0),
			);
		await prefetchChangedWorkComments(db, orgId, requests, prefetch);
	}
	const sources = requests.flatMap((request) => {
		const envelope = DecisionEnvelopeSchema.safeParse(
			request.metadata.decisionDeck,
		);
		return [
			request.metadata.decisionSources,
			envelope.success ? envelope.data.sources : undefined,
		].flatMap((raw) => DecisionSourcesSchema.safeParse(raw).data ?? []);
	});
	const outputIds = [
		...new Set(
			sources
				.filter((source) => source.kind === "output")
				.map((source) => source.id),
		),
	];
	if (outputIds.length) {
		const outputs = coreTable(db, d1WorkspaceOutputIndex);
		const rows = await db
			.select({
				id: outputs.outputId,
				status: outputs.status,
				revisionId: outputs.revisionId,
			})
			.from(outputs)
			.where(
				and(
					eq(outputs.organizationId, orgId),
					eq(outputs.isCurrent, 1),
					anyIds(db, outputs.outputId, outputIds),
				),
			);
		for (const row of rows) prefetch.outputs.set(row.id, row);
	}
	const threadIds = [
		...new Set(
			sources
				.filter((source) => source.kind === "email_thread")
				.map((source) => source.id),
		),
	];
	if (threadIds.length) {
		const threads = coreTable(db, d1TediEmailThreads);
		const messages = coreTable(db, d1TediEmailMessages);
		const rows = await db
			.select({
				id: threads.id,
				tediId: threads.tediId,
				updatedAt: threads.updatedAt,
				lastMessageAt: threads.lastMessageAt,
				messageCount: count(messages.id),
			})
			.from(threads)
			.leftJoin(
				messages,
				and(
					eq(messages.organizationId, threads.organizationId),
					eq(messages.tediId, threads.tediId),
					eq(messages.threadId, threads.id),
				),
			)
			.where(
				and(
					eq(threads.organizationId, orgId),
					anyIds(db, threads.id, threadIds),
				),
			)
			.groupBy(
				threads.id,
				threads.tediId,
				threads.updatedAt,
				threads.lastMessageAt,
			);
		for (const row of rows)
			prefetch.emailThreads.set(row.id, {
				...row,
				messageCount: Number(row.messageCount),
			});
	}
	return prefetch;
}

async function prefetchChangedWorkComments(
	db: DbQueryClient,
	orgId: string,
	requests: Request[],
	prefetch: DecisionSourcePrefetch,
) {
	const workItemComments = coreTable(db, d1WorkItemComments);
	const pins = requests.flatMap((request, requestIndex) => {
		const envelope = DecisionEnvelopeSchema.safeParse(
			request.metadata.decisionDeck,
		);
		const sources = [
			request.metadata.decisionSources,
			envelope.success ? envelope.data.sources : undefined,
		].flatMap((raw) => DecisionSourcesSchema.safeParse(raw).data ?? []);
		return sources.flatMap((source) =>
			source.kind === "work" &&
			prefetch.works.get(source.id)?.version === source.version &&
			(prefetch.commentCounts.get(source.id) ?? 0) > source.commentCount
				? [
						{
							requestIndex,
							workId: source.id,
							commentCount: source.commentCount,
							createdAt: request.createdAt || null,
							creatorType: request.creatorType ?? null,
							creatorId: request.creatorId || null,
						},
					]
				: [],
		);
	});
	if (!pins.length) return;
	const input = db.$with("changed_work_pins").as(
		db
			.selectDistinct({
				requestIndex:
					sql<number>`${jsonRead(db, sql`value`, ["requestIndex"], "number")}`.as(
						"request_index",
					),
				workId: sql<string>`${jsonRead(db, sql`value`, ["workId"])}`.as(
					"work_id",
				),
				commentCount:
					sql<number>`${jsonRead(db, sql`value`, ["commentCount"], "number")}`.as(
						"comment_count",
					),
				createdAt: sql<
					string | null
				>`${jsonRead(db, sql`value`, ["createdAt"])}`.as("created_at"),
				creatorType: sql<
					string | null
				>`${jsonRead(db, sql`value`, ["creatorType"])}`.as("creator_type"),
				creatorId: sql<
					string | null
				>`${jsonRead(db, sql`value`, ["creatorId"])}`.as("creator_id"),
			})
			.from(
				coreStore(db) === "postgres"
					? sql`jsonb_array_elements(${jsonParameter(db, pins)}) AS pins(value)`
					: sql`json_each(${JSON.stringify(pins)})`,
			),
	);
	const relevant = decisionRelevantWorkCommentFields(db, {
		createdAt: sql`${input.createdAt}`,
		creatorType: sql`${input.creatorType}`,
		creatorId: sql`${input.creatorId}`,
	});
	const counts = db.$with("changed_work_counts").as(
		db
			.select({
				requestIndex: input.requestIndex,
				workId: input.workId,
				commentCount: input.commentCount,
				baselineCount:
					sql<number>`coalesce(sum(CASE WHEN ${workItemComments.createdAt} <= ${input.createdAt} THEN 1 ELSE 0 END), 0)`.as(
						"baseline_count",
					),
				relevantCount:
					sql<number>`coalesce(sum(CASE WHEN ${relevant} THEN 1 ELSE 0 END), 0)`.as(
						"relevant_count",
					),
			})
			.from(input)
			.crossJoin(workItemComments)
			.where(
				and(
					eq(workItemComments.orgId, orgId),
					eq(workItemComments.workItemId, input.workId),
				),
			)
			.groupBy(input.requestIndex, input.workId, input.commentCount),
	);
	const latestComment = db
		.select({
			latest:
				sql<string>`${coreStore(db) === "postgres" ? sql`jsonb_build_object('through', ${workItemComments.createdAt}, 'note', substr(${workItemComments.body}, 1, 600))::text` : sql`json_object('through', ${workItemComments.createdAt}, 'note', substr(${workItemComments.body}, 1, 600))`}`.as(
					"latest",
				),
		})
		.from(workItemComments)
		.where(
			and(
				eq(workItemComments.orgId, orgId),
				eq(workItemComments.workItemId, input.workId),
				sql`(${counts.baselineCount} <> ${input.commentCount} OR ${relevant})`,
			),
		)
		.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
		.limit(1);
	// One JSON parameter holds the whole bounded inbox page, not one query per pin.
	const rows = await db
		.with(input, counts)
		.select({
			requestIndex: input.requestIndex,
			workId: input.workId,
			commentCount: input.commentCount,
			latest: sql<
				string | null
			>`CASE WHEN ${counts.baselineCount} = ${input.commentCount} AND ${counts.relevantCount} = ${input.commentCount} THEN NULL ELSE (${latestComment}) END`.as(
				"latest",
			),
		})
		.from(input)
		.innerJoin(
			counts,
			and(
				eq(counts.requestIndex, input.requestIndex),
				eq(counts.workId, input.workId),
				eq(counts.commentCount, input.commentCount),
			),
		);
	for (const row of rows) {
		const request = requests[row.requestIndex]!;
		const reviews = prefetch.workReviews.get(request) ?? new Map();
		const latest = row.latest
			? (JSON.parse(row.latest) as { through: string; note: string })
			: null;
		reviews.set(
			`${row.workId}:${row.commentCount}`,
			latest ? { ...latest, note: latest.note.slice(0, 600) } : true,
		);
		prefetch.workReviews.set(request, reviews);
	}
}

async function citedWork(
	db: DbQueryClient,
	orgId: string,
	id: string,
	prefetch?: DecisionSourcePrefetch,
) {
	if (prefetch?.commentCounts.has(id)) return prefetch.works.get(id) ?? null;
	const workItems = coreTable(db, d1WorkItems);
	const [row] = await db
		.select({
			disposition: workItems.disposition,
			version: workItems.version,
			executorId: workItems.executorId,
		})
		.from(workItems)
		.where(and(eq(workItems.id, id), eq(workItems.orgId, orgId)))
		.limit(1);
	return row ?? null;
}

export async function decisionSourcesReview(
	db: DbQueryClient,
	orgId: string,
	request: Request,
	options: { reviewedThrough?: string; prefetch?: DecisionSourcePrefetch } = {},
): Promise<SourceReview> {
	const current = { current: true } as const;
	const changed = { current: false } as const;
	if (
		request.status !== "open" ||
		request.targetType !== "user" ||
		request.kind === "coordination"
	)
		return current;
	if (informationalCapture(request.metadata)) return changed;
	const budgetCard = await creditBudgetCardCurrent(db, orgId, request.metadata);
	if (budgetCard !== undefined) return budgetCard ? current : changed;
	const envelope = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	if (request.metadata.decisionDeck !== undefined && !envelope.success)
		return changed;
	const lane = laneBlockerAsk(request);
	if (lane) {
		// A runner's permission card cites one Work version. Its Allow is fenced
		// on that version, executor and owner, so comments such as the runner's
		// own notes leave the ask unchanged; a new version gets a new card.
		const work = await citedWork(db, orgId, lane.workItemId, options.prefetch);
		return work?.disposition === "accepted" &&
			work.version === lane.workVersion &&
			String(work.executorId ?? "") === lane.executor
			? current
			: changed;
	}
	const records = [
		request.metadata.decisionSources,
		envelope.success ? envelope.data.sources : undefined,
	].filter((raw) => raw !== undefined);
	if (!records.length) {
		// Lane Done acknowledges a step the person performed; it approves no effect.
		const follow = request.metadata.followThrough;
		const handoff =
			request.metadata.laneHandoff ??
			(follow &&
			typeof follow === "object" &&
			!Array.isArray(follow) &&
			"laneHandoff" in follow
				? follow.laneHandoff
				: undefined);
		if (
			!envelope.success &&
			handoff &&
			typeof handoff === "object" &&
			!Array.isArray(handoff) &&
			"key" in handoff &&
			"nextClick" in handoff &&
			"requestId" in handoff &&
			typeof handoff.key === "string" &&
			typeof handoff.nextClick === "string" &&
			typeof handoff.requestId === "string"
		)
			return current;
		// Never grandfather irreversible approvals whose evidence was not recorded.
		if (
			humanReservedActionClasses(`${request.subject}\n${request.prompt}`).some(
				(kind) =>
					[
						"delete_data",
						"money",
						"external_message",
						"public_publish",
					].includes(kind),
			)
		)
			return changed;
		return !envelope.success ||
			!(
				envelope.data.reversibility === "one_way" ||
				envelope.data.protectedEffects.some((effect) =>
					["money", "message", "data"].includes(effect),
				)
			)
			? current
			: changed;
	}
	let reviewable: { through: string; note: string } | undefined;
	for (const raw of records) {
		const sources = DecisionSourcesSchema.safeParse(raw);
		if (!sources.success) return changed;
		for (const source of sources.data) {
			const match = await decisionSourceMatches(
				db,
				orgId,
				source,
				request,
				options.reviewedThrough,
				options.prefetch,
			);
			if (match === false) return changed;
			if (match !== true && (!reviewable || match.through > reviewable.through))
				reviewable = match;
		}
	}
	return reviewable ? { current: false, reviewable } : current;
}

/** Expire only the checked version; keep its facts and history without recording an answer. */
export async function retireDecisionSourceCard(
	db: DbQueryClient,
	p: {
		orgId: string;
		id: string;
		targetId: string;
		version: number;
		now: string;
	},
) {
	const auditEvents = coreTable(db, d1AuditEvents);
	const workInteractions = coreTable(db, d1WorkInteractions);
	const fence = crypto.randomUUID();
	const [retired] = await db.batch([
		db
			.update(workInteractions)
			.set({
				status: "expired",
				expiredAt: p.now,
				resolutionFence: fence,
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					eq(workInteractions.id, p.id),
					eq(workInteractions.version, p.version),
					eq(workInteractions.status, "open"),
					eq(workInteractions.targetType, "user"),
					eq(workInteractions.targetId, p.targetId),
				),
			)
			.returning({ id: workInteractions.id }),
		db.insert(auditEvents).select(
			db
				.select({
					id: sql<string>`${fence}`.as("id"),
					organizationId: workInteractions.orgId,
					actorId: sql<string>`'tedix'`.as("actor_id"),
					actorType: sql<string>`'service'`.as("actor_type"),
					action: sql<string>`'decision.sources.expired'`.as("action"),
					resourceType: sql<string>`'work_interaction'`.as("resource_type"),
					resourceId: workInteractions.id,
					metadata:
						sql<string>`${jsonParameter(db, { reason: "decision_sources_changed", at: p.now })}`.as(
							"metadata",
						),
					timestamp: sql<number>`${interactionAuditTime(db, p.now)}`.as(
						"timestamp",
					),
				})
				.from(workInteractions)
				.where(
					and(
						eq(workInteractions.orgId, p.orgId),
						eq(workInteractions.id, p.id),
						eq(workInteractions.resolutionFence, fence),
					),
				),
		),
	]);
	return retired;
}

/** Only tenant-scoped reads; missing/archived sources never validate a decision. */
/** The Work version a lane permission card asks about, when the card is one. */
function laneBlockerAsk(request: Request) {
	const blocker = request.metadata.laneBlocker;
	if (
		request.metadata.source !== "lane-dispatch-blocker" ||
		!request.workItemId ||
		!blocker ||
		typeof blocker !== "object" ||
		Array.isArray(blocker)
	)
		return null;
	const { workVersion, executor } = blocker as Record<string, unknown>;
	if (typeof workVersion !== "number" || !Number.isInteger(workVersion))
		return null;
	return {
		workItemId: request.workItemId,
		workVersion,
		executor: typeof executor === "string" ? executor : "",
	};
}

async function decisionSourceMatches(
	db: DbQueryClient,
	orgId: string,
	source: DecisionSource,
	request: Request,
	reviewedThrough?: string,
	prefetch?: DecisionSourcePrefetch,
): Promise<boolean | { through: string; note: string }> {
	const tediEmailMessages = coreTable(db, d1TediEmailMessages);
	const tediEmailThreads = coreTable(db, d1TediEmailThreads);
	const workItemComments = coreTable(db, d1WorkItemComments);
	const workspaceOutputIndex = coreTable(db, d1WorkspaceOutputIndex);
	switch (source.kind) {
		case "work": {
			const work = await citedWork(db, orgId, source.id, prefetch);
			if (!work || work.version !== source.version) return false;
			// Same answer as the full count below, without reading again.
			const prefetched = prefetch?.commentCounts.get(source.id);
			if (prefetched !== undefined) {
				if (prefetched === source.commentCount) return true;
				if (prefetched < source.commentCount) return false;
			}
			const review = prefetch?.workReviews
				.get(request)
				?.get(`${source.id}:${source.commentCount}`);
			if (review !== undefined)
				return typeof review === "boolean" ||
					!reviewedThrough ||
					review.through > reviewedThrough
					? review
					: true;
			const relevant = decisionRelevantWorkComment(db, request);
			const [comments] = await db
				.select({
					count: sql<number>`count(*)`,
					relevantCount: sql<number>`coalesce(sum(case when ${relevant} then 1 else 0 end), 0)`,
					baselineCount: sql<number>`coalesce(sum(case when ${workItemComments.createdAt} <= ${request.createdAt ?? null} then 1 else 0 end), 0)`,
				})
				.from(workItemComments)
				.where(
					and(
						eq(workItemComments.orgId, orgId),
						eq(workItemComments.workItemId, source.id),
					),
				);
			const count = Number(comments?.count);
			if (count === source.commentCount) return true;
			if (count < source.commentCount) return false;
			// The pin counts all comments. Exempt progress only when its original baseline is intact.
			const progressExempt =
				Number(comments?.baselineCount) === source.commentCount;
			if (
				progressExempt &&
				Number(comments?.relevantCount) === source.commentCount
			)
				return true;
			// Only newer comments: current through what the person has read.
			const [latest] = await db
				.select({
					body: workItemComments.body,
					createdAt: workItemComments.createdAt,
				})
				.from(workItemComments)
				.where(
					and(
						eq(workItemComments.orgId, orgId),
						eq(workItemComments.workItemId, source.id),
						progressExempt ? relevant : undefined,
						reviewedThrough
							? gt(workItemComments.createdAt, reviewedThrough)
							: undefined,
					),
				)
				.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
				.limit(1);
			if (!latest) return true;
			return { through: latest.createdAt, note: latest.body.slice(0, 600) };
		}
		case "output": {
			if (prefetch) {
				const output = prefetch.outputs.get(source.id);
				return (
					output?.status === "active" && output.revisionId === source.revisionId
				);
			}
			const [output] = await db
				.select({
					status: workspaceOutputIndex.status,
					currentRevisionId: workspaceOutputIndex.revisionId,
				})
				.from(workspaceOutputIndex)
				.where(
					and(
						eq(workspaceOutputIndex.organizationId, orgId),
						eq(workspaceOutputIndex.outputId, source.id),
						eq(workspaceOutputIndex.isCurrent, 1),
					),
				)
				.limit(1);
			return (
				output?.status === "active" &&
				output.currentRevisionId === source.revisionId
			);
		}
		case "email_thread": {
			if (prefetch) {
				const thread = prefetch.emailThreads.get(source.id);
				return (
					!!thread &&
					thread.tediId === source.tediId &&
					thread.updatedAt === source.updatedAt &&
					thread.lastMessageAt === source.lastMessageAt &&
					thread.messageCount === source.messageCount
				);
			}
			const [thread] = await db
				.select({
					updatedAt: tediEmailThreads.updatedAt,
					lastMessageAt: tediEmailThreads.lastMessageAt,
				})
				.from(tediEmailThreads)
				.where(
					and(
						eq(tediEmailThreads.id, source.id),
						eq(tediEmailThreads.organizationId, orgId),
						eq(tediEmailThreads.tediId, source.tediId),
					),
				)
				.limit(1);
			if (
				!thread ||
				thread.updatedAt !== source.updatedAt ||
				thread.lastMessageAt !== source.lastMessageAt
			)
				return false;
			// Count also catches delayed inbound messages whose timestamp precedes the latest message.
			const [messages] = await db
				.select({ count: sql<number>`count(*)` })
				.from(tediEmailMessages)
				.where(
					and(
						eq(tediEmailMessages.threadId, source.id),
						eq(tediEmailMessages.organizationId, orgId),
						eq(tediEmailMessages.tediId, source.tediId),
					),
				);
			return Number(messages?.count) === source.messageCount;
		}
	}
}
