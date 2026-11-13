import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
	COMMITMENT_REMINDER_CLOSING_EVENTS,
	COMMITMENT_REMINDER_SOURCE,
} from "@tedix/api-contract/utils/commitment-reminder";
import type { DbQueryClient } from "../../query-client";
import { workInteractions } from "../../schema/work-factory";
import { workEvents, workItems } from "../../schema/work-items";
import { tedis } from "../../schema/tedis";
import { chunkForBoundParams } from "../../utils/batch";

const isReminder = sql`json_extract(${workInteractions.metadata}, '$.source') = ${COMMITMENT_REMINDER_SOURCE}`;

/** Preserve the request and its history while returning engineering status asks to a tedi. */
export async function routeEngineeringCommitmentReminders(
	db: DbQueryClient,
	limit = 100,
) {
	const w = alias(workItems, "w");
	const t = alias(tedis, "t");
	const rows = await db
		.select({
			id: workInteractions.id,
			orgId: workInteractions.orgId,
			version: workInteractions.version,
			tediId: sql<string>`${t.id}`.as("tediId"),
		})
		.from(workInteractions)
		.innerJoin(
			w,
			and(
				eq(w.orgId, workInteractions.orgId),
				eq(w.id, workInteractions.workItemId),
			),
		)
		.innerJoin(
			t,
			and(
				eq(t.organizationId, w.orgId),
				eq(t.status, "active"),
				sql`${t.id} = coalesce(
				(select id from tedis where organization_id = ${w.orgId} and id = ${w.stewardId}
				 and ${w.stewardType} = 'tedi' and status = 'active'),
				case when ${workInteractions.creatorType} = 'tedi' then ${workInteractions.creatorId} end)`,
			),
		)
		.where(
			and(
				isReminder,
				eq(w.workKind, "coding"),
				eq(workInteractions.status, "open"),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.kind, "question"),
				sql`json_extract(${workInteractions.metadata}, '$.decisionDeck') IS NULL`,
				sql`json_extract(${workInteractions.metadata}, '$.approvalOperation') IS NULL`,
			),
		)
		.limit(Math.max(1, Math.min(200, limit)));
	const routed: string[] = [];
	for (const row of rows) {
		const changed = await db
			.update(workInteractions)
			.set({
				targetType: "tedi",
				targetId: row.tediId,
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, row.orgId),
					eq(workInteractions.id, row.id),
					eq(workInteractions.version, row.version),
					eq(workInteractions.status, "open"),
					eq(workInteractions.targetType, "user"),
				),
			)
			.returning({ id: workInteractions.id });
		routed.push(...changed.map(({ id }) => id));
	}
	return routed;
}

/** The person a reminder asks closes any of their open reminders in one step. */
export async function dismissCommitmentReminders(
	db: DbQueryClient,
	p: {
		orgId: string;
		targetType: "user" | "tedi" | "external_agent";
		targetId: string;
		ids: readonly string[];
		now: string;
	},
): Promise<string[]> {
	const dismissed: string[] = [];
	for (const ids of chunkForBoundParams([...p.ids], 50)) {
		const rows = await db
			.update(workInteractions)
			.set({
				status: "cancelled",
				cancelledAt: p.now,
				resolutionFence: crypto.randomUUID(),
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					eq(workInteractions.orgId, p.orgId),
					inArray(workInteractions.id, ids),
					eq(workInteractions.status, "open"),
					sql`${workInteractions.targetType} = ${p.targetType}`,
					eq(workInteractions.targetId, p.targetId),
					isReminder,
				),
			)
			.returning({ id: workInteractions.id });
		dismissed.push(...rows.map((row) => row.id));
	}
	return dismissed;
}

/**
 * A reminder asks for the status of idle or overdue Work. Once that Work is
 * finished, cancelled, or changes state after the reminder was filed, the
 * question no longer applies, so the reminder closes itself.
 */
export async function closeSettledCommitmentReminders(
	db: DbQueryClient,
	p: { now: string; limit?: number },
): Promise<string[]> {
	const w = alias(workItems, "w");
	const e = alias(workEvents, "e");
	const due = db
		.select({ id: workInteractions.id })
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.status, "open"),
				isReminder,
				exists(
					db
						.select({ one: sql`1` })
						.from(w)
						.where(
							and(
								eq(w.orgId, workInteractions.orgId),
								eq(w.id, workInteractions.workItemId),
								or(
									inArray(w.disposition, ["completed", "cancelled"]),
									exists(
										db
											.select({ one: sql`1` })
											.from(e)
											.where(
												and(
													eq(e.orgId, w.orgId),
													eq(e.workItemId, w.id),
													sql`${e.occurredAt} > ${workInteractions.createdAt}`,
													inArray(e.eventType, [
														...COMMITMENT_REMINDER_CLOSING_EVENTS,
													]),
												),
											),
									),
								),
							),
						),
				),
			),
		)
		.limit(Math.max(1, Math.min(200, p.limit ?? 100)));
	const closed: string[] = [];
	const ids = (await due).map((row) => row.id);
	for (const chunk of chunkForBoundParams(ids, 50)) {
		const rows = await db
			.update(workInteractions)
			.set({
				status: "cancelled",
				cancelledAt: p.now,
				resolutionFence: crypto.randomUUID(),
				version: sql`${workInteractions.version}+1`,
			})
			.where(
				and(
					inArray(workInteractions.id, chunk),
					eq(workInteractions.status, "open"),
					isReminder,
				),
			)
			.returning({ id: workInteractions.id });
		closed.push(...rows.map((row) => row.id));
	}
	return closed;
}
