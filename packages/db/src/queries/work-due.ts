import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { workDue } from "../schema/work-due";

export type WorkDueRow = typeof workDue.$inferSelect;

/** One bounded, atomic claim. Expired claims remain eligible after a crash. */
export async function claimWorkDue(
	db: DbQueryClient,
	now: string,
	leaseUntil: string,
) {
	return db
		.update(workDue)
		.set({ leaseUntil })
		.where(sql`(${workDue.orgId}, ${workDue.kind}, ${workDue.objectId}) IN (
		SELECT org_id, kind, object_id FROM work_due
		WHERE status='pending' AND due_at<=${now} AND lease_until<=${now}
		ORDER BY due_at, org_id, kind, object_id LIMIT 50
	)`)
		.returning();
}

/** Writers clear the claim when the object changes; an old finish cannot overwrite it. */
export async function releaseWorkDue(
	db: DbQueryClient,
	rows: WorkDueRow[],
	next: string,
	retire = false,
) {
	const statements = rows.map((row) => {
		const match = and(
			eq(workDue.orgId, row.orgId),
			eq(workDue.kind, row.kind),
			eq(workDue.objectId, row.objectId),
			eq(workDue.leaseUntil, row.leaseUntil),
			eq(workDue.dueAt, row.dueAt),
		);
		return retire
			? db.delete(workDue).where(match)
			: db.update(workDue).set({ dueAt: next, leaseUntil: "" }).where(match);
	});
	const [first, ...rest] = statements;
	if (first) await db.batch([first, ...rest]);
}
