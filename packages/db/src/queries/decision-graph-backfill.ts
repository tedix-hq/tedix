/** Bounded historical sources and durable progress for the decision maintenance tick. */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
	DECISION_GRAPH_BACKFILL_PHASES,
	DecisionGraphBackfillCursorSchema,
	type DecisionGraphBackfillCursor,
} from "@tedix/api-contract/schemas/decision-graph-backfill";
import type { DbQueryClient } from "../query-client";
import { organizations } from "../schema/organizations";
import { platformCronCheckpoints } from "../schema/platform-cron-executions";
import { workInteractions } from "../schema/work-factory";
import type { DecisionEdgeInput } from "./decision-graph";

type Source = {
	id: string;
	at: string;
	subjectId: string | null;
	targetId: string | null;
	extraId: string | null;
	data: string | null;
};
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
	// Each statement selects unique output names and binds at most six values.
	const queries = {
		cards: sql`SELECT c.id AS id, c.created_at AS at, c.id AS subjectId,
   w.id AS targetId, CASE WHEN c.target_type='user' THEN c.target_id END AS extraId,
   CASE WHEN c.status='cancelled' THEN c.metadata END AS data
   FROM work_interactions c LEFT JOIN work_items w ON w.id=c.work_item_id AND w.org_id=c.org_id
   WHERE c.org_id=${org} AND c.id>${after} ORDER BY c.id LIMIT ${limit}`,
		responses: sql`SELECT r.id AS id, r.responded_at AS at, c.id AS subjectId,
   w.id AS targetId, NULL AS extraId, NULL AS data
   FROM work_interaction_responses r JOIN work_interactions c ON c.id=r.interaction_id AND c.org_id=r.org_id
   LEFT JOIN work_items w ON w.id=c.work_item_id AND w.org_id=c.org_id
   WHERE r.org_id=${org} AND r.id>${after} AND r.resolves_request=1 AND c.status='resolved'
   AND r.resolved_request_version=c.version ORDER BY r.id LIMIT ${limit}`,
		approvals: sql`SELECT d.id AS id, d.decided_at AS at, p.id AS subjectId,
   w.id AS targetId, NULL AS extraId, NULL AS data
   FROM work_approval_decisions d JOIN work_approval_proposals p ON p.id=d.proposal_id
   JOIN work_items w ON w.id=p.work_item_id AND w.org_id=p.org_id
   WHERE p.org_id=${org} AND d.id>${after} AND p.status=d.decision
   ORDER BY d.id LIMIT ${limit}`,
		tedi_approvals: sql`SELECT a.id AS id, a.resolved_at AS at, a.id AS subjectId,
   w.id AS targetId, NULL AS extraId, NULL AS data
   FROM tedi_approval_requests a LEFT JOIN work_items w
   ON w.id=json_extract(a.payload,'$.workItemId') AND w.org_id=a.org_id
   WHERE a.org_id=${org} AND a.id>${after} AND a.status IN ('approved','rejected')
   AND a.resolved_at IS NOT NULL ORDER BY a.id LIMIT ${limit}`,
		decisions: sql`SELECT d.id AS id, d.created_at AS at, w.id AS subjectId,
   NULL AS targetId, NULL AS extraId, NULL AS data
   FROM tedi_rationale_records d JOIN work_items w ON w.id=d.work_item_id AND w.org_id=d.org_id
   WHERE d.org_id=${org} AND d.id>${after} AND d.category='decision' AND d.outcome_status='success'
   ORDER BY d.id LIMIT ${limit}`,
		work_items: sql`SELECT w.id AS id, w.created_at AS at, w.id AS subjectId,
   CASE WHEN w.accountable_owner_type='user' THEN w.accountable_owner_id END AS targetId,
   NULL AS extraId, NULL AS data FROM work_items w
   WHERE w.org_id=${org} AND w.id>${after} ORDER BY w.id LIMIT ${limit}`,
		relations: sql`SELECT r.id AS id, r.created_at AS at, a.id AS subjectId,
   b.id AS targetId, NULL AS extraId, NULL AS data FROM work_item_relations r
   JOIN work_items a ON a.id=r.from_work_item_id AND a.org_id=r.org_id
   JOIN work_items b ON b.id=r.to_work_item_id AND b.org_id=r.org_id
   WHERE r.org_id=${org} AND r.id>${after} AND r.relation_type='blocks'
   ORDER BY r.id LIMIT ${limit}`,
		comments: sql`SELECT c.id AS id, c.created_at AS at, w.id AS subjectId,
   CASE WHEN c.author_type='user' THEN c.author_id END AS targetId,
   NULL AS extraId, NULL AS data FROM work_item_comments c
   JOIN work_items w ON w.id=c.work_item_id AND w.org_id=c.org_id
   WHERE c.org_id=${org} AND c.id>${after} ORDER BY c.id LIMIT ${limit}`,
		instructions: sql`SELECT f.id AS id, f.created_at AS at, w.id AS subjectId,
   f.fact_type AS targetId, NULL AS extraId, NULL AS data FROM memory_facts f
   LEFT JOIN work_item_comments c ON c.org_id=f.organization_id AND
    c.id=coalesce(json_extract(f.metadata,'$.workCommentId'),
     CASE WHEN substr(f.source,1,length('work-comment://'))='work-comment://'
      THEN substr(f.source,length('work-comment://')+1)
      WHEN substr(f.source,1,length('work-comment:'))='work-comment:'
      THEN substr(f.source,length('work-comment:')+1) END)
   JOIN work_items w ON w.org_id=f.organization_id AND
    w.id=coalesce(json_extract(f.metadata,'$.workItemId'), CASE WHEN c.author_type='user' THEN c.work_item_id END)
   WHERE f.organization_id=${org} AND f.id>${after} AND f.review_status='confirmed'
    AND f.use_policy='can_use_as_instruction' AND f.status='active' AND f.archived_at IS NULL AND f.valid_to IS NULL
    AND f.fact_type IN ('feedback','preference','decision') ORDER BY f.id LIMIT ${limit}`,
		evidence: sql`SELECT e.id AS id, e.submitted_at AS at, w.id AS subjectId,
   coalesce(target.id,o.id) AS targetId,
   CASE WHEN target.id IS NULL THEN 'output' ELSE 'work_item' END AS extraId, NULL AS data FROM work_evidence e
   JOIN work_items w ON w.id=e.work_item_id AND w.org_id=e.org_id
   LEFT JOIN work_items target ON substr(e.uri,1,7)='work://' AND
    target.id=substr(e.uri,8) AND target.org_id=e.org_id
   LEFT JOIN os_outputs o ON o.organization_id=e.org_id AND substr(e.uri,1,9)='output://' AND
    o.id=CASE WHEN instr(substr(e.uri,10),'/')>0
     THEN substr(e.uri,10,instr(substr(e.uri,10),'/')-1) ELSE substr(e.uri,10) END
   WHERE e.org_id=${org} AND e.id>${after} AND coalesce(target.id,o.id) IS NOT NULL
   ORDER BY e.id LIMIT ${limit}`,
	};
	const rows = await db.all<Source>(queries[cursor.phase]);
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
