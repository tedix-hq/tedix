import { z } from "zod";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { createDbClient } from "@tedix/db/client";
import {
	getDueCommitmentWake,
	listDueCommitmentWakes,
	recordCommitmentWakesQueued,
	retainCommitmentWakeChanges,
	pruneCommitmentWakeReceipts,
} from "@tedix/db/queries/work-items/commitment-changes";

// Private queue messages cannot be submitted through the public automation schema.
const CommitmentWakeQueueSchema = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("commitment_wake"), id: z.string().min(1) }),
	z.object({
		kind: z.literal("commitment_wake_catchup"),
		scheduledTime: z.number().int().nonnegative(),
	}),
]);

export async function enqueueDueCommitmentWakes(
	env: CloudflareEnv,
	scheduledTime: number,
) {
	if (!env.AUTOMATION_EVENTS)
		throw new Error("Commitment wakes require the automation events queue");
	const db = createDbClient(env.DB);
	const now = new Date(Math.max(Date.now(), scheduledTime)).toISOString();
	const due = await listDueCommitmentWakes(db, now, env.ENVIRONMENT);
	await env.AUTOMATION_EVENTS.sendBatch([
		...due.map(({ id }) => ({
			body: { kind: "commitment_wake", id },
			contentType: "json" as const,
		})),
		{
			body: { kind: "commitment_wake_catchup", scheduledTime },
			contentType: "json" as const,
		},
	]);
	// Queue acceptance precedes the resend lease. A crash can duplicate a message,
	// but cannot hide an unaccepted one. Rows remain until a delivery receipt.
	await recordCommitmentWakesQueued(
		db,
		due.map(({ id }) => id),
		now,
	);
	return { queued: due.length, catchupQueued: 1 };
}

export async function handleCommitmentWakeMessage(
	env: CloudflareEnv,
	body: unknown,
): Promise<"ack" | "retry"> {
	const parsed = CommitmentWakeQueueSchema.safeParse(body);
	if (!parsed.success) return "ack";
	const db = createDbClient(env.DB);
	const { processCommitmentWakePage } =
		await import("../jobs/commitment-wakes");
	try {
		if (parsed.data.kind === "commitment_wake_catchup") {
			const counts = await processCommitmentWakePage(
				env,
				parsed.data.scheduledTime,
				{
					collect: (changes) => retainCommitmentWakeChanges(db, changes),
					maxPages: 1,
				},
			);
			console.log("commitment.wake.catchup", {
				scheduledTime: parsed.data.scheduledTime,
				...counts,
			});
			await pruneCommitmentWakeReceipts(
				db,
				new Date(Date.now() - 86_400_000).toISOString(),
			);
			return "ack";
		}
		const source = await getDueCommitmentWake(
			db,
			parsed.data.id,
			env.ENVIRONMENT,
		);
		if (!source) return "ack";
		const counts = await processCommitmentWakePage(env, Date.now(), { source });
		const outcome = counts.deferred || counts.budgetExhausted ? "retry" : "ack";
		console.log("commitment.wake.receipt", {
			id: source.id,
			dueAt: source.dueAt,
			outcome,
			...counts,
		});
		return outcome;
	} catch (error) {
		console.warn("commitment.wake.failed", {
			...parsed.data,
			error: safeExceptionTopology(error),
		});
		return "retry";
	}
}
