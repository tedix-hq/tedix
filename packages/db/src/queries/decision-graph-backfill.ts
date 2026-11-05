/** Bounded historical sources and durable progress for the decision maintenance tick. */
import {
	and,
	asc,
	eq,
	gt,
	inArray,
	isNotNull,
	isNull,
	type SQLWrapper,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
	DECISION_GRAPH_BACKFILL_PHASES,
	DecisionGraphBackfillCursorSchema,
	type DecisionGraphBackfillCursor,
} from "@tedix/api-contract/schemas/decision-graph-backfill";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { platformCronCheckpoints } from "../schema/platform-cron-executions";
import { tediApprovalRequests } from "../schema/approvals";
import { memoryFacts } from "../schema/memory-graph";
import { osOutputs } from "../schema/os-workspaces";
import { tediRationaleRecords } from "../schema/rationale-records";
import {
	workApprovalDecisions,
	workApprovalProposals,
	workInteractionResponses,
	workInteractions,
} from "../schema/work-factory";
import {
	workEvidence,
	workItemComments,
	workItemRelations,
	workItems,
} from "../schema/work-items";
import type { DecisionEdgeInput } from "./decision-graph";

type Source = {
	id: string;
	at: string;
	subjectId: string | null;
	targetId: string | null;
	extraId: string | null;
	data: string | null;
};
const NULL_SOURCE_FIELD = sql`NULL`;

/** Every phase projects the same raw, uniquely named Source columns. */
function sourceFields(fields: {
	id: SQLWrapper;
	at: SQLWrapper;
	subjectId: SQLWrapper;
	targetId?: SQLWrapper;
	extraId?: SQLWrapper;
	data?: SQLWrapper;
}) {
	return {
		id: sql<string>`${fields.id}`.as("id"),
		at: sql<string>`${fields.at}`.as("at"),
		subjectId: sql<string | null>`${fields.subjectId}`.as("subjectId"),
		targetId: sql<string | null>`${fields.targetId ?? NULL_SOURCE_FIELD}`.as(
			"targetId",
		),
		extraId: sql<string | null>`${fields.extraId ?? NULL_SOURCE_FIELD}`.as(
			"extraId",
		),
		data: sql<string | null>`${fields.data ?? NULL_SOURCE_FIELD}`.as("data"),
	};
}
const CHECKPOINT = "decision-graph-backfill:v1:";
const DECISION_GRAPH_BACKFILL_BATCH_SIZE = 50;

/** These scans use the existing tenant indexes and a stable primary-key cursor. */
export async function planDecisionGraphBackfillPage(
	db: DbQueryClient,
	organizationId: string,
	input: { cursor?: DecisionGraphBackfillCursor | null; limit?: number },
) {
	const cursor = input.cursor
		? DecisionGraphBackfillCursorSchema.parse(input.cursor)
		: { organizationId, phase: "cards" as const, afterId: "" };
	if (cursor.organizationId !== organizationId)
		throw new Error("Backfill cursor belongs to another organization");
	const limit = input.limit ?? DECISION_GRAPH_BACKFILL_BATCH_SIZE;
	if (!Number.isInteger(limit) || limit < 1 || limit > 50)
		throw new Error("Backfill page limit must be within 1..50");
	const org = organizationId;
	const after = cursor.afterId;
	// Each statement selects unique output names and binds at most nine values.
	const c = alias(workInteractions, "c");
	const w = alias(workItems, "w");
	const queries = {
		cards: () =>
			db
				.select(
					sourceFields({
						id: c.id,
						at: c.createdAt,
						subjectId: c.id,
						targetId: w.id,
						extraId: sql`CASE WHEN ${c.targetType}='user' THEN ${c.targetId} END`,
						data: sql`CASE WHEN ${c.status}='cancelled' THEN ${c.metadata} END`,
					}),
				)
				.from(c)
				.leftJoin(w, and(eq(w.id, c.workItemId), eq(w.orgId, c.orgId)))
				.where(and(eq(c.orgId, org), gt(c.id, after)))
				.orderBy(c.id)
				.limit(limit),
		responses: () => {
			const r = workInteractionResponses;
			return db
				.select(
					sourceFields({
						id: r.id,
						at: r.respondedAt,
						subjectId: c.id,
						targetId: w.id,
					}),
				)
				.from(r)
				.innerJoin(c, and(eq(c.id, r.interactionId), eq(c.orgId, r.orgId)))
				.leftJoin(w, and(eq(w.id, c.workItemId), eq(w.orgId, c.orgId)))
				.where(
					and(
						eq(r.orgId, org),
						gt(r.id, after),
						sql`${r.resolvesRequest}=1`,
						eq(c.status, "resolved"),
						eq(r.resolvedRequestVersion, c.version),
					),
				)
				.orderBy(r.id)
				.limit(limit);
		},
		approvals: () => {
			const d = workApprovalDecisions;
			const p = workApprovalProposals;
			return db
				.select(
					sourceFields({
						id: d.id,
						at: d.decidedAt,
						subjectId: p.id,
						targetId: w.id,
					}),
				)
				.from(d)
				.innerJoin(p, eq(p.id, d.proposalId))
				.innerJoin(w, and(eq(w.id, p.workItemId), eq(w.orgId, p.orgId)))
				.where(
					and(
						eq(p.orgId, org),
						gt(d.id, after),
						sql`${p.status}=${d.decision}`,
					),
				)
				.orderBy(d.id)
				.limit(limit);
		},
		tedi_approvals: () => {
			const a = tediApprovalRequests;
			return db
				.select(
					sourceFields({
						id: a.id,
						at: a.resolvedAt,
						subjectId: a.id,
						targetId: w.id,
					}),
				)
				.from(a)
				.leftJoin(
					w,
					and(
						sql`${w.id}=json_extract(${a.payload},'$.workItemId')`,
						eq(w.orgId, a.orgId),
					),
				)
				.where(
					and(
						eq(a.orgId, org),
						gt(a.id, after),
						inArray(a.status, ["approved", "rejected"]),
						isNotNull(a.resolvedAt),
					),
				)
				.orderBy(a.id)
				.limit(limit);
		},
		decisions: () => {
			const d = tediRationaleRecords;
			return db
				.select(sourceFields({ id: d.id, at: d.createdAt, subjectId: w.id }))
				.from(d)
				.innerJoin(w, and(eq(w.id, d.workItemId), eq(w.orgId, d.orgId)))
				.where(
					and(
						eq(d.orgId, org),
						gt(d.id, after),
						eq(d.category, "decision"),
						eq(d.outcomeStatus, "success"),
					),
				)
				.orderBy(d.id)
				.limit(limit);
		},
		work_items: () =>
			db
				.select(
					sourceFields({
						id: w.id,
						at: w.createdAt,
						subjectId: w.id,
						targetId: sql`CASE WHEN ${w.accountableOwnerType}='user' THEN ${w.accountableOwnerId} END`,
					}),
				)
				.from(w)
				.where(and(eq(w.orgId, org), gt(w.id, after)))
				.orderBy(w.id)
				.limit(limit),
		relations: () => {
			const r = workItemRelations;
			const a = alias(workItems, "a");
			const b = alias(workItems, "b");
			return db
				.select(
					sourceFields({
						id: r.id,
						at: r.createdAt,
						subjectId: a.id,
						targetId: b.id,
					}),
				)
				.from(r)
				.innerJoin(a, and(eq(a.id, r.fromWorkItemId), eq(a.orgId, r.orgId)))
				.innerJoin(b, and(eq(b.id, r.toWorkItemId), eq(b.orgId, r.orgId)))
				.where(
					and(eq(r.orgId, org), gt(r.id, after), eq(r.relationType, "blocks")),
				)
				.orderBy(r.id)
				.limit(limit);
		},
		comments: () => {
			const comment = alias(workItemComments, "c");
			return db
				.select(
					sourceFields({
						id: comment.id,
						at: comment.createdAt,
						subjectId: w.id,
						targetId: sql`CASE WHEN ${comment.authorType}='user' THEN ${comment.authorId} END`,
					}),
				)
				.from(comment)
				.innerJoin(
					w,
					and(eq(w.id, comment.workItemId), eq(w.orgId, comment.orgId)),
				)
				.where(and(eq(comment.orgId, org), gt(comment.id, after)))
				.orderBy(comment.id)
				.limit(limit);
		},
		instructions: () => {
			const f = alias(memoryFacts, "f");
			const comment = alias(workItemComments, "c");
			return db
				.select(
					sourceFields({
						id: f.id,
						at: f.createdAt,
						subjectId: w.id,
						targetId: f.factType,
					}),
				)
				.from(f)
				.leftJoin(
					comment,
					and(
						eq(comment.orgId, f.organizationId),
						sql`${comment.id}=coalesce(json_extract(${f.metadata},'$.workCommentId'),
     CASE WHEN substr(${f.source},1,length('work-comment://'))='work-comment://'
      THEN substr(${f.source},length('work-comment://')+1)
      WHEN substr(${f.source},1,length('work-comment:'))='work-comment:'
      THEN substr(${f.source},length('work-comment:')+1) END)`,
					),
				)
				.innerJoin(
					w,
					and(
						eq(w.orgId, f.organizationId),
						sql`${w.id}=coalesce(json_extract(${f.metadata},'$.workItemId'), CASE WHEN ${comment.authorType}='user' THEN ${comment.workItemId} END)`,
					),
				)
				.where(
					and(
						eq(f.organizationId, org),
						gt(f.id, after),
						eq(f.reviewStatus, "confirmed"),
						eq(f.usePolicy, "can_use_as_instruction"),
						eq(f.status, "active"),
						isNull(f.archivedAt),
						isNull(f.validTo),
						inArray(f.factType, ["feedback", "preference", "decision"]),
					),
				)
				.orderBy(f.id)
				.limit(limit);
		},
		evidence: () => {
			const e = workEvidence;
			const target = alias(workItems, "target");
			const o = osOutputs;
			const targetId = sql`coalesce(${target.id},${o.id})`;
			return db
				.select(
					sourceFields({
						id: e.id,
						at: e.submittedAt,
						subjectId: w.id,
						targetId,
						extraId: sql`CASE WHEN ${target.id} IS NULL THEN 'output' ELSE 'work_item' END`,
					}),
				)
				.from(e)
				.innerJoin(w, and(eq(w.id, e.workItemId), eq(w.orgId, e.orgId)))
				.leftJoin(
					target,
					and(
						sql`substr(${e.uri},1,7)='work://'`,
						sql`${target.id}=substr(${e.uri},8)`,
						eq(target.orgId, e.orgId),
					),
				)
				.leftJoin(
					o,
					and(
						eq(o.organizationId, e.orgId),
						sql`substr(${e.uri},1,9)='output://'`,
						sql`${o.id}=CASE WHEN instr(substr(${e.uri},10),'/')>0
     THEN substr(${e.uri},10,instr(substr(${e.uri},10),'/')-1) ELSE substr(${e.uri},10) END`,
					),
				)
				.where(
					and(eq(e.orgId, org), gt(e.id, after), sql`${targetId} IS NOT NULL`),
				)
				.orderBy(e.id)
				.limit(limit);
		},
	};
	const rows: Source[] = await queries[cursor.phase]();
	const edges: DecisionEdgeInput[] = [];
	const add = (
		row: Source,
		kind: DecisionEdgeInput["kind"],
		fromKind: DecisionEdgeInput["from"]["kind"],
		fromId: string | null,
		toKind: DecisionEdgeInput["to"]["kind"],
		toId: string | null,
		note: string,
	) => {
		if (!fromId || !toId || (fromKind === toKind && fromId === toId)) return;
		edges.push({
			kind,
			from: { kind: fromKind, id: fromId },
			to: { kind: toKind, id: toId },
			source: "backfill",
			confidence: 1,
			evidenceRef: `${cursor.phase}:${row.id}`,
			note,
			occurredAt: row.at,
		});
	};
	// Resolve curation successors in one tenant-fenced, <=50-id lookup.
	const successors = new Map<string, { id: string; duplicate: boolean }>();
	if (cursor.phase === "cards") {
		for (const row of rows) {
			const metadata = row.data ? JSON.parse(row.data) : {};
			const curation = metadata?.curation;
			if (typeof curation?.successorId === "string" && curation.successorId)
				successors.set(row.id, {
					id: curation.successorId,
					duplicate: curation.retirement?.reason === "duplicate",
				});
		}
	}
	const ids = [...new Set([...successors.values()].map((s) => s.id))];
	const validSuccessors = new Set(
		ids.length
			? (
					await db
						.select({ id: workInteractions.id })
						.from(workInteractions)
						.where(
							and(
								eq(workInteractions.orgId, org),
								inArray(workInteractions.id, ids),
							),
						)
						.limit(50)
				).map((r) => r.id)
			: [],
	);
	for (const row of rows) {
		switch (cursor.phase) {
			case "cards": {
				add(
					row,
					"card_from_work",
					"deck_card",
					row.subjectId,
					"work_item",
					row.targetId,
					"Source Work item",
				);
				add(
					row,
					"involves",
					"deck_card",
					row.subjectId,
					"person",
					row.extraId,
					"Asked person",
				);
				const next = successors.get(row.id);
				if (next && validSuccessors.has(next.id)) {
					add(
						row,
						"supersedes",
						"deck_card",
						next.id,
						"deck_card",
						row.id,
						"Replacement card",
					);
					if (next.duplicate)
						add(
							row,
							"same_as",
							"deck_card",
							row.id,
							"deck_card",
							next.id,
							"Merged duplicate",
						);
				}
				break;
			}
			case "responses":
			case "approvals":
			case "tedi_approvals": {
				const cardId =
					cursor.phase === "approvals"
						? `work-approval:${row.subjectId}`
						: cursor.phase === "tedi_approvals"
							? `approval:${row.subjectId}`
							: row.subjectId;
				add(
					row,
					"card_answers",
					"deck_card",
					cardId,
					"decision",
					row.id,
					"Recorded answer",
				);
				add(
					row,
					"decided_by",
					"work_item",
					row.targetId,
					"decision",
					row.id,
					"Recorded decision",
				);
				break;
			}
			case "decisions":
				add(
					row,
					"decided_by",
					"work_item",
					row.subjectId,
					"decision",
					row.id,
					"Recorded decision",
				);
				break;
			case "work_items":
			case "comments":
				add(
					row,
					"involves",
					"work_item",
					row.subjectId,
					"person",
					row.targetId,
					"Work participant",
				);
				break;
			case "relations":
				add(
					row,
					"blocks",
					"work_item",
					row.subjectId,
					"work_item",
					row.targetId,
					"Blocked Work item",
				);
				break;
			case "instructions":
				add(
					row,
					"decided_by",
					"work_item",
					row.subjectId,
					row.targetId === "decision" ? "decision" : "owner_instruction",
					row.id,
					"Captured owner instruction",
				);
				break;
			case "evidence":
				add(
					row,
					"evidence",
					"work_item",
					row.subjectId,
					row.extraId === "output" ? "output" : "work_item",
					row.targetId,
					"Linked evidence",
				);
				break;
		}
	}
	const unique = [
		...new Map(
			edges.map((e) => [JSON.stringify([e.from, e.kind, e.to]), e]),
		).values(),
	];
	const nextPhase =
		DECISION_GRAPH_BACKFILL_PHASES[
			DECISION_GRAPH_BACKFILL_PHASES.indexOf(cursor.phase) + 1
		];
	const nextCursor: DecisionGraphBackfillCursor | null =
		rows.length === limit
			? { ...cursor, afterId: rows.at(-1)!.id }
			: nextPhase
				? { organizationId, phase: nextPhase, afterId: "" }
				: null;
	return { scanned: rows.length, edges: unique, nextCursor };
}

export async function getDecisionGraphBackfillCheckpoint(
	db: DbQueryClient,
	key: string,
) {
	const [row] = await db
		.select()
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, CHECKPOINT + key))
		.limit(1);
	return row?.through ?? null;
}
/** Compare-and-set progress; a delayed duplicate tick cannot rewind a newer cursor. */
export async function advanceDecisionGraphBackfillCheckpoint(
	db: DbQueryClient,
	key: string,
	previous: string | null,
	next: string,
) {
	await db
		.insert(platformCronCheckpoints)
		.values({ scheduleId: CHECKPOINT + key, through: next })
		.onConflictDoUpdate({
			target: platformCronCheckpoints.scheduleId,
			set: { through: next },
			setWhere:
				previous === null
					? sql`0`
					: eq(platformCronCheckpoints.through, previous),
		});
}
export async function nextDecisionGraphBackfillOrganization(
	db: DbQueryClient,
	afterId: string,
) {
	const [row] = await db
		.select({ id: organizations.id })
		.from(organizations)
		.where(gt(organizations.id, afterId))
		.orderBy(asc(organizations.id))
		.limit(1);
	return row?.id ?? null;
}
