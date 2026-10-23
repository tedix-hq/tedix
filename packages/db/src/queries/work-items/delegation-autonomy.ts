import { and, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workEvents } from "../../schema/work-items";
import { sha256Hex } from "@tedix/worker-kit/crypto";
import { withTransientD1ReadRetry } from "../../utils/d1-retry";

async function delegationEventId(key: string): Promise<string> {
	const hex = await sha256Hex(key);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export interface DelegationFyi {
	classId: string;
	policyPack?: { id: string; version: number };
	homeRunId: string;
	childRunId: string;
	tediId: string;
	tediName: string;
	task: string;
	outcome: string;
}

/** A deterministic canonical Work event, projected into Feed rather than Deck. */
export async function recordDelegationFyi(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		at: string;
		fyi: DelegationFyi;
	},
) {
	const summary = `Delegated “${input.fyi.task.slice(0, 100)}” to ${input.fyi.tediName}: ${input.fyi.outcome}.`;
	await db
		.insert(workEvents)
		.values({
			id: await delegationEventId(
				JSON.stringify([
					"fyi",
					input.orgId,
					input.workItemId,
					input.fyi.childRunId,
					input.fyi.outcome,
				]),
			),
			orgId: input.orgId,
			workItemId: input.workItemId,
			eventType: "delegation.fyi",
			actorType: "system",
			actorId: "home",
			payload: { summary, delegationFyi: { ...input.fyi }, policyVersion: 1 },
			occurredAt: input.at,
		})
		.onConflictDoNothing();
}

export async function readDelegationFyi(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		eventId?: string;
		childRunId?: string;
	},
) {
	const [row] = await db
		.select()
		.from(workEvents)
		.where(
			and(
				eq(workEvents.orgId, input.orgId),
				eq(workEvents.workItemId, input.workItemId),
				eq(workEvents.eventType, "delegation.fyi"),
				eq(workEvents.actorType, "system"),
				eq(workEvents.actorId, "home"),
				...(input.eventId ? [eq(workEvents.id, input.eventId)] : []),
				...(input.childRunId
					? [
							sql`json_extract(${workEvents.payload}, '$.delegationFyi.childRunId') = ${input.childRunId}`,
						]
					: []),
			),
		)
		.limit(1);
	return row ?? null;
}

/** User feedback is an immediate, durable deny lesson for the exact delegation class. */
export async function recordDelegationAutonomyFeedback(
	db: DbQueryClient,
	input: {
		orgId: string;
		workItemId: string;
		eventId: string;
		userId: string;
		at: string;
	},
) {
	const source = await readDelegationFyi(db, input);
	const fyi = source?.payload.delegationFyi;
	if (
		!fyi ||
		typeof fyi !== "object" ||
		Array.isArray(fyi) ||
		typeof fyi.classId !== "string"
	)
		throw new Error("Delegation FYI not found");
	await db
		.insert(workEvents)
		.values({
			id: await delegationEventId(
				JSON.stringify(["feedback", source!.id, input.userId]),
			),
			orgId: input.orgId,
			workItemId: input.workItemId,
			eventType: "delegation.autonomy.corrected",
			actorType: "user",
			actorId: input.userId,
			payload: {
				summary:
					"This delegation should have asked me. Ask before this class of work next time.",
				classId: fyi.classId,
				sourceEventId: source!.id,
				lesson: "require_human_approval",
			},
			occurredAt: input.at,
		})
		.onConflictDoNothing();
	return { classId: fyi.classId, requiresHumanApproval: true as const };
}

export async function readDelegationAutonomyLessons(
	db: DbQueryClient,
	orgId: string,
): Promise<string[]> {
	const rows = await withTransientD1ReadRetry(
		"delegation-autonomy-lessons",
		async () =>
			await db
				.selectDistinct({
					classId: sql<string>`json_extract(${workEvents.payload}, '$.classId')`,
				})
				.from(workEvents)
				.where(
					and(
						eq(workEvents.orgId, orgId),
						eq(workEvents.eventType, "delegation.autonomy.corrected"),
						eq(workEvents.actorType, "user"),
					),
				)
				.limit(101),
	);
	if (rows.length > 100)
		throw new Error("Autonomy lesson inventory exceeds limit");
	return rows
		.map((row) => row.classId)
		.filter((value) => typeof value === "string");
}
