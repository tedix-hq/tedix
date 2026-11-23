import { DYNAMIC_WORKER_PROVIDER } from "@tedix/api-contract/utils/credit-pricing";
import { and, eq, inArray, sql } from "drizzle-orm";
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
	// Leave room for the organization and any workspace and period filters.
	for (const runIds of chunkForBoundParams([...new Set(input.runIds)], 90)) {
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
					eq(charge.organizationId, input.organizationId),
					sql`${charge.provider} <> ${DYNAMIC_WORKER_PROVIDER}`,
					inArray(runId, runIds),
					workspaceChat
						? and(
								sql`${charge.occurredAt} >= ${workspaceChat.periodStart}`,
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
