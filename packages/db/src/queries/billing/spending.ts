import { DYNAMIC_WORKER_PROVIDER } from "@tedix/api-contract/utils/credit-pricing";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	billingUsageCharges,
	billingUsageReservations,
} from "../../schema/billing";
import { chunkForBoundParams } from "../../utils/batch";

export type RunCreditTotal = { credits: number; chargeCount: number };

type RunCreditParams = {
	organizationId: string;
	runIds: readonly string[];
	workspaceChat?: { workspaceId: string; periodStart: string };
};

/**
 * Tedix credits recorded for AI calls of `runIds`, per run, from each call's
 * settled charge. A pre-wallet charge names its run through its D1
 * reservation; a wallet-settled charge carries the run and the hold's request
 * metadata itself. Runs with no charge are left out: absent is never a known
 * zero.
 */
export async function sumRunCreditsByRun(
	db: DbClient,
	input: RunCreditParams,
): Promise<Map<string, RunCreditTotal>> {
	const byRun = new Map<string, RunCreditTotal>();
	const workspaceChat = input.workspaceChat;
	const charge = billingUsageCharges;
	const reservation = billingUsageReservations;
	const runId = sql<
		string | null
	>`COALESCE(${reservation.runId}, json_extract(${charge.metadata}, '$.runId'))`;
	const requestField = (field: string) =>
		sql`COALESCE(json_extract(${reservation.metadata}, ${`$.${field}`}), json_extract(${charge.metadata}, ${`$.reservation.${field}`}))`;
	const chargeRunId = sql<string>`json_extract(${charge.metadata}, '$.runId')`;
	// Each run ID is bound in both candidate branches and the effective-run check.
	for (const runIds of chunkForBoundParams([...new Set(input.runIds)], 28)) {
		const reservations = db
			.select({ id: reservation.id })
			.from(reservation)
			.where(
				and(
					eq(reservation.organizationId, input.organizationId),
					inArray(reservation.runId, runIds),
				),
			);
		const rows = await db
			.select({
				runId: runId.as("run_id"),
				credits: sql<number>`coalesce(sum(${charge.credits}), 0)`.as("credits"),
				chargeCount: sql<number>`count(${charge.id})`.as("charge_count"),
			})
			.from(charge)
			.leftJoin(
				reservation,
				and(
					eq(reservation.id, charge.reservationId),
					eq(reservation.organizationId, charge.organizationId),
				),
			)
			.where(
				and(
					// Keep the outer tenant guard out of index selection: the OR
					// branches seek by reservation or wallet run, never the whole org.
					sql`+${charge.organizationId} = ${input.organizationId}`,
					or(
						// bound-params: SQL subquery; its run IDs use the 28-value chunk above.
						inArray(charge.reservationId, reservations),
						and(
							eq(charge.organizationId, input.organizationId),
							inArray(chargeRunId, runIds),
						),
					),
					sql`${charge.provider} <> ${DYNAMIC_WORKER_PROVIDER}`,
					inArray(runId, runIds),
					workspaceChat
						? and(
								// Filter the period after seeking runs, not via an org-period scan.
								sql`+${charge.occurredAt} >= ${workspaceChat.periodStart}`,
								sql`${requestField("source")} = 'workspace_chat'`,
								sql`${requestField("workspaceId")} = ${workspaceChat.workspaceId}`,
							)
						: undefined,
				),
			)
			.groupBy(runId);
		for (const row of rows) {
			if (!row.runId) continue;
			byRun.set(row.runId, {
				credits: Number(row.credits ?? 0),
				chargeCount: Number(row.chargeCount ?? 0),
			});
		}
	}
	return byRun;
}

/** Tedix credits recorded for AI calls of all `runIds`, summed. */
export async function sumRunCredits(
	db: DbClient,
	input: RunCreditParams,
): Promise<RunCreditTotal> {
	let credits = 0;
	let chargeCount = 0;
	for (const total of (await sumRunCreditsByRun(db, input)).values()) {
		credits += total.credits;
		chargeCount += total.chargeCount;
	}
	return { credits, chargeCount };
}
