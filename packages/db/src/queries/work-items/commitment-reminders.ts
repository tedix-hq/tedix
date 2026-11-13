import { and, eq, exists, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
	COMMITMENT_REMINDER_CLOSING_EVENTS,
	COMMITMENT_REMINDER_SOURCE,
} from "@tedix/api-contract/utils/commitment-reminder";
import type { DbQueryClient } from "../../query-client";
import { workInteractions } from "../../schema/work-factory";
import { workEvents, workItems } from "../../schema/work-items";
import { chunkForBoundParams } from "../../utils/batch";

const isReminder = sql`json_extract(${workInteractions.metadata}, '$.source') = ${COMMITMENT_REMINDER_SOURCE}`;

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
