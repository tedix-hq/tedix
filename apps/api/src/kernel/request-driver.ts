import {
	routeKernelRequest,
	type KernelExecutorRouter,
} from "./request-executor-routing";
import type { DbQueryClient } from "@tedix/db/query-client";
import {
	getKernelRequest,
	transitionKernelRequest,
	type KernelRequestScope,
} from "@tedix/db/queries/kernel-requests";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";
import type { KernelRequestSnapshot } from "@tedix/api-contract/schemas/kernel-request";
import {
	advanceKernelRequest,
	runKernelAcceptanceChecks,
	type KernelAcceptanceReader,
	type KernelRequestEvent,
} from "./request-coordinator";

export interface KernelRequestDriverPolicy {
	nextOwner: string;
	retryMs: number;
	probeTimeoutMs: number;
	maxProbeAttempts: number;
	runBudgetMs: number;
}

/** One durable transition. CAS losers reload; they never overwrite a successor's state. */
export async function applyKernelRequestEvent(
	db: DbQueryClient,
	row: KernelRequestRow,
	event: KernelRequestEvent,
	policy: KernelRequestDriverPolicy,
	now: string,
): Promise<KernelRequestRow> {
	const snapshot = advanceKernelRequest(row.id, row.snapshot, event);
	if (snapshot === row.snapshot) return row;
	const terminal =
		snapshot.state === "learned" || snapshot.state === "cancelled";
	return (
		(await transitionKernelRequest(db, {
			organizationId: row.organizationId,
			ownerUserId: row.ownerUserId,
			id: row.id,
			expectedVersion: row.version,
			eventId: `${row.id}:${row.version + 1}`,
			snapshot,
			nextOwner: policy.nextOwner,
			nextAction: nextKernelRequestAction(snapshot),
			nextDueAt: terminal
				? null
				: new Date(Date.parse(now) + policy.retryMs).toISOString(),
			now,
		})) ??
		(await getKernelRequest(db, row)) ??
		row
	);
}

function nextKernelRequestAction(s: KernelRequestSnapshot) {
	switch (s.state) {
		case "received":
			return "file_request";
		case "filed":
			return "prepare_brief";
		case "briefed":
			return "await_admitted_attempt";
		case "running":
			return s.laneCheckpoint &&
				s.laneCheckpoint.previousAttemptId === s.attemptId
				? `lane_${s.laneCheckpoint.status}`
				: "read_attempt_terminal";
		case "verifying":
			return s.delivery
				? "deliver_report"
				: s.outcome === "failed"
					? "prepare_repair"
					: "check_targets";
		case "reported":
			return "record_learning_disposition";
		case "learned":
			return "closed";
		case "cancelled":
			return "cancelled";
	}
}

export interface KernelRequestSourceReader {
	executorRouter?: KernelExecutorRouter;
	/** Re-read canonical Work/Attempt and source ACLs; never trust a terminal notification. */
	readExecution(row: KernelRequestRow): Promise<{
		attemptId: string;
		outcome: "succeeded" | "failed" | "cancelled" | null;
	}>;
	/** Idempotency key is the durable delivery intent. Return only a source acknowledgment. */
	deliverReport(
		row: KernelRequestRow,
		intentId: string,
	): Promise<{ status: "acknowledged" | "unavailable"; receiptRef: string }>;
}

/** Bounded recovery step, shared by terminal notifications and the existing kernel wake. */
export async function driveKernelRequest(
	db: DbQueryClient,
	scope: KernelRequestScope,
	policy: KernelRequestDriverPolicy,
	source: KernelRequestSourceReader,
	reader: KernelAcceptanceReader,
	now: () => string,
): Promise<KernelRequestRow | undefined> {
	let row = await getKernelRequest(db, scope);
	if (!row) return;
	if (row.snapshot.state === "running" && source.executorRouter) {
		row = await routeKernelRequest(
			row,
			source.executorRouter,
			(current, checkpoint) =>
				applyKernelRequestEvent(
					db,
					current,
					{ kind: "lane_checkpoint", checkpoint },
					policy,
					now(),
				),
			now(),
			policy.retryMs * policy.maxProbeAttempts,
		);
		const checkpoint = row.snapshot.laneCheckpoint;
		if (checkpoint && checkpoint.previousAttemptId === row.snapshot.attemptId) {
			if (checkpoint.status !== "continued" || !checkpoint.successorAttemptId)
				return row;
			row = await applyKernelRequestEvent(
				db,
				row,
				{
					kind: "successor",
					previousAttemptId: checkpoint.previousAttemptId,
					attemptId: checkpoint.successorAttemptId,
				},
				policy,
				now(),
			);
		}
	}
	if (row.snapshot.state === "running") {
		const execution = await source.readExecution(row);
		if (execution.outcome && execution.attemptId === row.snapshot.attemptId)
			row = await applyKernelRequestEvent(
				db,
				row,
				{
					kind: "terminal",
					attemptId: execution.attemptId,
					outcome: execution.outcome,
				},
				policy,
				now(),
			);
	}
	if (
		row.snapshot.state === "verifying" &&
		row.snapshot.acceptanceKey &&
		!row.snapshot.delivery
	) {
		if ((row.snapshot.probeAttempts ?? 0) >= policy.maxProbeAttempts)
			return row;
		const acceptanceKey = row.snapshot.acceptanceKey;
		const deadline = Date.now() + policy.runBudgetMs;
		const timeout = () =>
			Math.max(1, Math.min(policy.probeTimeoutMs, deadline - Date.now()));
		const timed: KernelAcceptanceReader = {
			readHomeResponse: reader.readHomeResponse
				? () => withDeadline(() => reader.readHomeResponse!(), timeout())
				: undefined,
			readOutputRevision: (check) =>
				withDeadline(() => reader.readOutputRevision(check), timeout()),
			readRepositoryDelivery: (check) =>
				withDeadline(() => reader.readRepositoryDelivery(check), timeout()),
			readWorkCommitDelivery: reader.readWorkCommitDelivery
				? (check) =>
						withDeadline(() => reader.readWorkCommitDelivery!(check), timeout())
				: undefined,
		};
		const observations = await runKernelAcceptanceChecks(
			row.snapshot.checks,
			timed,
			now,
		);
		row = await applyKernelRequestEvent(
			db,
			row,
			{ kind: "checked", acceptanceKey, observations },
			policy,
			now(),
		);
		if (row.snapshot.outcome === "verified")
			row = await applyKernelRequestEvent(
				db,
				row,
				{ kind: "delivery_intent", intentId: `${acceptanceKey}:report` },
				policy,
				now(),
			);
	}
	if (
		row.snapshot.state === "verifying" &&
		row.snapshot.delivery?.status === "pending"
	) {
		const intentId = row.snapshot.delivery.intentId;
		const receipt = await source.deliverReport(row, intentId);
		row = await applyKernelRequestEvent(
			db,
			row,
			{ kind: "delivered", intentId, ...receipt },
			policy,
			now(),
		);
	}
	if (row.snapshot.state === "reported")
		row = await applyKernelRequestEvent(
			db,
			row,
			{ kind: "learn", disposition: "no_new_lesson" },
			policy,
			now(),
		);
	return row;
}

async function withDeadline<T>(
	read: () => Promise<T>,
	timeoutMs: number,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			read(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Target probe deadline elapsed")),
					timeoutMs,
				);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
