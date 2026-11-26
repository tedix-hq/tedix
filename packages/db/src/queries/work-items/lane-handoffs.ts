import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import {
	coreStore,
	jsonParameter,
	jsonRead,
	jsonWrite,
} from "../../core-store/dialect";
import { workInteractions as d1WorkInteractions } from "../../schema/work-factory";
import { interactionColumns, interactionJsonType } from "./interaction-store";
/** Once a reminder's original ask leaves open, the reminder is cancelled; metadata stays fenced. */
export async function withdrawStaleLaneNudges(db: DbQueryClient, now: string) {
	const workInteractions = coreTable(db, d1WorkInteractions);
	const rows = await db
		.update(workInteractions)
		.set({
			status: "cancelled",
			cancelledAt: now,
			resolutionFence:
				coreStore(db) === "postgres"
					? sql`gen_random_uuid()::text`
					: sql`lower(hex(randomblob(16)))`,
			version: sql`${workInteractions.version}+1`,
		})
		.where(
			and(
				eq(workInteractions.status, "open"),
				sql`${interactionJsonType(db, workInteractions.metadata, ["laneNudge", "requestId"])}='text'`,
				sql`NOT EXISTS (SELECT 1 FROM work_interactions o WHERE o.org_id=${workInteractions.orgId} AND o.id=${jsonRead(db, workInteractions.metadata, ["laneNudge", "requestId"], "text")} AND o.status='open' AND (o.expires_at IS NULL OR o.expires_at>${now}))`,
			),
		)
		.returning({ id: workInteractions.id });
	return rows.length;
}

/** One morning reminder per unanswered ask per UTC day, using the existing digest surface. */
export async function nudgeLaneHandoffs(db: DbQueryClient, now: string) {
	await withdrawStaleLaneNudges(db, now);
	const hour = new Date(now).getUTCHours();
	if (hour < 8 || hour >= 12) return 0;
	const day = now.slice(0, 10);
	const cutoff = new Date(Date.parse(now) - 86_400_000).toISOString();
	const workInteractions = coreTable(db, d1WorkInteractions);
	const due = and(
		eq(workInteractions.status, "open"),
		eq(workInteractions.targetType, "user"),
		sql`(${interactionJsonType(db, workInteractions.metadata, ["laneHandoff"])}='object' OR ${interactionJsonType(db, workInteractions.metadata, ["followThrough", "laneHandoff"])}='object')`,
		sql`${workInteractions.createdAt}<=${cutoff}`,
		sql`coalesce(${jsonRead(db, workInteractions.metadata, ["followThrough", "lastNudgedDay"], "text")},'')<${day}`,
		sql`coalesce(${jsonRead(db, workInteractions.metadata, ["followThrough", "snoozedUntil"], "text")},'')<=${now}`,
		sql`${jsonRead(db, workInteractions.metadata, ["followThrough", "reviewAt"], "text")}>${now}`,
		sql`(${workInteractions.expiresAt} IS NULL OR ${workInteractions.expiresAt}>${now})`,
		sql`NOT EXISTS (SELECT 1 FROM work_items w WHERE w.org_id=${workInteractions.orgId} AND w.id=${workInteractions.workItemId} AND w.disposition IN ('completed','cancelled'))`,
	);
	const rows = await db
		.select(interactionColumns(db))
		.from(workInteractions)
		.where(due)
		.limit(50);
	let count = 0;
	for (const row of rows) {
		const hash = new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(`lane-nudge:${row.id}:${day}`),
			),
		);
		const hex = [...hash.slice(0, 16)]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
		const [created] = await db.batch([
			db
				.insert(workInteractions)
				.select(
					db
						.select({
							id: sql<string>`${id}`.as("id"),
							orgId: workInteractions.orgId,
							workItemId: workInteractions.workItemId,
							kind: sql<string>`'coordination'`.as("kind"),
							creatorType: sql<string>`'system'`.as("creator_type"),
							creatorId: sql<string>`'tedix'`.as("creator_id"),
							targetType: workInteractions.targetType,
							targetId: workInteractions.targetId,
							subject:
								sql<string>`substr('Needs you: ' || ${workInteractions.subject},1,300)`.as(
									"subject",
								),
							prompt:
								sql<string>`${`Reminder of an open ask. Next step: ${row.subject}\nOpen the original ask: /work/interactions/${row.id}\nMarking this reminder done performs no step and changes nothing; do the step, then use Done or Snooze 1 day on the original ask.`}`.as(
									"prompt",
								),
							metadata:
								sql<string>`${jsonParameter(db, { notification: { state: "digest", requestIds: [row.id] }, laneNudge: { requestId: row.id, day } })}`.as(
									"metadata",
								),
							createdAt: sql<string>`${now}`.as("created_at"),
							expiresAt:
								sql<string>`${new Date(Date.parse(now) + 86_400_000).toISOString()}`.as(
									"expires_at",
								),
						})
						.from(workInteractions)
						.where(
							and(
								due,
								eq(workInteractions.id, row.id),
								eq(workInteractions.orgId, row.orgId),
							),
						),
				)
				.onConflictDoNothing()
				.returning({ id: workInteractions.id }),
			db
				.update(workInteractions)
				.set({
					metadata: jsonWrite(
						db,
						workInteractions.metadata,
						["followThrough", "lastNudgedDay"],
						day,
					),
				})
				.where(
					and(
						eq(workInteractions.orgId, row.orgId),
						eq(workInteractions.id, row.id),
						sql`EXISTS (SELECT 1 FROM work_interactions n WHERE n.org_id=${row.orgId} AND n.id=${id})`,
					),
				),
		]);
		count += created.length;
	}
	return count;
}
