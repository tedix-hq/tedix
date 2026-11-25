import { coreTable } from "../../core-store/client";
import {
	anyIds,
	coreStore,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import { interactionColumns } from "./interaction-store";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractions as d1WorkInteractions,
	type WorkInteraction,
} from "../../schema/work-factory";
import { WorkControlError } from "./factory-validation";
import { workItems as d1WorkItems } from "../../schema/work-items";
import { nudgeLaneHandoffs } from "./lane-handoffs";

/** Four-hour digests, with overnight preparation held for the 08:00 UTC brief. */
export function nextInteractionDigestAt(now: string): string {
	const next = new Date(
		Math.floor(Date.parse(now) / 14_400_000) * 14_400_000 + 14_400_000,
	);
	if (next.getUTCHours() < 8) next.setUTCHours(8, 0, 0, 0);
	return next.toISOString();
}

/** Global maintenance; each digest is scoped to one exact tenant and recipient. */
export async function flushWorkInteractionDigests(
	db: DbQueryClient,
	now: string,
) {
	const workInteractions = coreTable(db, d1WorkInteractions);
	const workItems = coreTable(db, d1WorkItems);
	await nudgeLaneHandoffs(db, now);
	const nearDeadline = new Date(Date.parse(now) + 86_400_000).toISOString();
	const slotStart = new Date(
		Math.floor(Date.parse(now) / 14_400_000) * 14_400_000,
	).toISOString();
	const rows = await db
		.select({
			...interactionColumns(db),
			sourceDisposition: sql<string | null>`${workItems.disposition}`.as(
				"source_disposition",
			),
			sourceDeadline: sql<string | null>`${workItems.deadline}`.as(
				"source_deadline",
			),
			sourceDueDate: sql<string | null>`${workItems.dueDate}`.as(
				"source_due_date",
			),
		})
		.from(workInteractions)
		.leftJoin(
			workItems,
			and(
				eq(workItems.orgId, workInteractions.orgId),
				eq(workItems.id, workInteractions.workItemId),
			),
		)
		.where(
			and(
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "user"),
				sql`${jsonRead(db, workInteractions.metadata, ["notification", "state"])}='deferred'`,
				sql`(${workInteractions.expiresAt}<=${now} OR ${workInteractions.dueAt}<${nearDeadline}
					OR EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND (w.disposition IN ('completed','cancelled') OR coalesce(w.deadline,w.due_date)<${nearDeadline}))
					OR (${jsonRead(db, workInteractions.metadata, ["notification", "deliverAt"])}<=${now} AND NOT EXISTS (SELECT 1 FROM work_interactions digest WHERE digest.org_id=${workInteractions.orgId} AND digest.target_id=${workInteractions.targetId} AND ${jsonRead(db, sql`digest.metadata`, ["notification", "state"])}='digest' AND digest.created_at>=${slotStart})))`,
			),
		)
		.orderBy(asc(workInteractions.createdAt), asc(workInteractions.id))
		.limit(100);
	const groups = new Map<string, WorkInteraction[]>();
	const statements = [];
	const digestIndexes: number[] = [];
	let suppressed = 0,
		escalated = 0,
		digests = 0;
	for (const row of rows) {
		if (row.workItemId && row.sourceDisposition === null)
			throw new WorkControlError("NOT_FOUND", "Work item not found");
		const obsolete =
			(row.expiresAt !== null && row.expiresAt <= now) ||
			row.sourceDisposition === "completed" ||
			row.sourceDisposition === "cancelled";
		const deadline = [row.dueAt, row.sourceDeadline, row.sourceDueDate]
			.filter((at): at is string => Boolean(at))
			.sort()[0];
		const urgent = Boolean(
			deadline && Date.parse(deadline) - Date.parse(now) < 86_400_000,
		);
		if (obsolete || urgent) {
			statements.push(
				db
					.update(workInteractions)
					.set({
						metadata: jsonWrite(
							db,
							jsonWrite(
								db,
								workInteractions.metadata,
								["notification", "state"],
								obsolete ? "suppressed" : "immediate",
							),
							["notification", "reason"],
							obsolete ? "already_handled" : "deadline_under_24h",
						),
					})
					.where(
						and(
							eq(workInteractions.orgId, row.orgId),
							eq(workInteractions.id, row.id),
							eq(workInteractions.status, "open"),
						),
					),
			);
			if (obsolete) suppressed++;
			else escalated++;
			continue;
		}
		const notification = row.metadata.notification as { deliverAt: string };
		if (notification.deliverAt > now || new Date(now).getUTCHours() < 8)
			continue;
		const key = `${row.orgId}:${row.targetId}`;
		const group = groups.get(key) ?? [];
		if (group.length < 20) group.push(row);
		groups.set(key, group);
	}
	for (const group of groups.values()) {
		const first = group[0]!;
		const slot = Math.floor(Date.parse(now) / 14_400_000);
		const hash = new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					`digest:${first.orgId}:${first.targetId}:${slot}`,
				),
			),
		);
		const hex = [...hash.slice(0, 16)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		const ids = group.map((row) => row.id);
		// The membership test prevents a racing tick from claiming rows omitted
		// from the winning digest. A late arrival waits for the following slot.
		digestIndexes.push(statements.length);
		statements.push(
			db
				.insert(workInteractions)
				.select(
					db
						.select({
							id: sql<string>`${id}`.as("id"),
							orgId: sql<string>`${first.orgId}`.as("org_id"),
							workItemId: sql<string | null>`${first.workItemId}`.as(
								"work_item_id",
							),
							caseId: sql<string | null>`${first.caseId}`.as("case_id"),
							projectId: sql<string | null>`${first.projectId}`.as(
								"project_id",
							),
							kind: sql<"coordination">`'coordination'`.as("kind"),
							status: sql<"open">`'open'`.as("status"),
							creatorType: sql<"system">`'system'`.as("creator_type"),
							creatorId: sql<string>`'tedix'`.as("creator_id"),
							targetType: sql<"user">`'user'`.as("target_type"),
							targetId: sql<string>`${first.targetId}`.as("target_id"),
							subject:
								sql<string>`'Tedi digest: ' || count(*) || ' updates'`.as(
									"subject",
								),
							prompt:
								sql<string>`${coreStore(db) === "postgres" ? sql`string_agg` : sql`group_concat`}('- ' || ${workInteractions.subject} || ': ' || substr(${workInteractions.prompt},1,500) || ${coreStore(db) === "postgres" ? sql`chr(10)` : sql`char(10)`} || 'Request: ' || ${workInteractions.id}, ${coreStore(db) === "postgres" ? sql`chr(10)` : sql`char(10)`})`.as(
									"prompt",
								),
							metadata: sql<
								Record<string, JsonValue>
							>`${coreStore(db) === "postgres" ? sql`jsonb_build_object('notification',jsonb_build_object('state','digest','requestIds',jsonb_agg(${workInteractions.id})))` : sql`json_object('notification',json_object('state','digest','requestIds',json_group_array(${workInteractions.id})))`}`.as(
								"metadata",
							),
							createdAt: sql<string>`${now}`.as("created_at"),
						})
						.from(workInteractions)
						.where(
							and(
								eq(workInteractions.orgId, first.orgId),
								eq(workInteractions.targetId, first.targetId!),
								eq(workInteractions.status, "open"),
								sql`${jsonRead(db, workInteractions.metadata, ["notification", "state"])}='deferred'`,
								sql`(${workInteractions.dueAt} IS NULL OR ${workInteractions.dueAt}>=${nearDeadline})`,
								// bound-params: at most 20 digest members
								anyIds(db, workInteractions.id, ids),
								sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${now})`,
								sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND (w.disposition IN ('completed','cancelled') OR coalesce(w.deadline,w.due_date)<${nearDeadline}))`,
							),
						)
						.having(sql`count(*)>0`),
				)
				.onConflictDoNothing()
				.returning({ id: workInteractions.id }),
			db
				.update(workInteractions)
				.set({
					metadata: jsonWrite(
						db,
						jsonWrite(
							db,
							workInteractions.metadata,
							["notification", "state"],
							"bundled",
						),
						["notification", "digestId"],
						id,
					),
				})
				.where(
					and(
						eq(workInteractions.orgId, first.orgId),
						anyIds(db, workInteractions.id, ids),
						eq(workInteractions.status, "open"),
						sql`${jsonRead(db, workInteractions.metadata, ["notification", "state"])}='deferred'`,
						sql`EXISTS (SELECT 1 FROM work_interactions digest, ${coreStore(db) === "postgres" ? sql`jsonb_array_elements_text(${jsonRead(db, sql`digest.metadata`, ["notification", "requestIds"], "json")}) AS member(value)` : sql`json_each(digest.metadata,'$.notification.requestIds') member`} WHERE digest.org_id=${first.orgId} AND digest.id=${id} AND member.value=${workInteractions.id})`,
					),
				),
		);
	}
	if (statements.length) {
		const results = await db.batch(
			statements as [(typeof statements)[number], ...typeof statements],
		);
		for (const index of digestIndexes) {
			const created = results[index];
			if (Array.isArray(created)) digests += created.length;
		}
	}
	return { digests, suppressed, escalated };
}
