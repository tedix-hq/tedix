import type {
	KernelAcceptanceCheck,
	KernelRequestPolicy,
} from "@tedix/api-contract/schemas/kernel-request";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	DISPATCHER_ATTEMPT_CAPTURE_LOOKBACK_MS,
	getKernelRequest,
	listUncapturedDispatcherAttempts,
	receiveKernelRequest,
	transitionKernelRequest,
} from "@tedix/db/queries/kernel-requests";
import { findRepositoryPushObservations } from "@tedix/db/queries/repository-observer";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { listWorkItemAttempts } from "@tedix/db/queries/work-items/attempts";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import { proposeWorkDeliveryRepair } from "@tedix/db/queries/work-items/delivery-repair";
import type { KernelRequestRow } from "@tedix/db/schema/kernel-requests";
import type { WorkAttempt } from "@tedix/db/schema/work-items";
import type { BaseContext } from "../rpc/orpc";
import {
	receivedKernelRequest,
	runKernelAcceptanceChecks,
	type KernelAcceptanceReader,
	type KernelRequestEvent,
} from "./request-coordinator";
import { applyKernelRequestEvent, driveKernelRequest } from "./request-driver";

const SHA = /^[a-f0-9]{40}$/;
/** A pushed observation older than this cannot prove or disprove a new delivery. */
const PUSH_LOOKBACK_MS = 14 * 86_400_000;

/**
 * Commit identities a lane-serve settlement reported. `commitShas` (full SHAs)
 * and `baseSha` (main when the lane started) are the agreed fields; `commits`
 * and a single `commitSha` are tolerated. Short SHAs are ignored, never padded.
 */
export function settledCommitShas(metadata: Record<string, JsonValue>) {
	const commitShas = [
		...new Set(
			[metadata.commitShas, metadata.commits, metadata.commitSha]
				.flatMap((value) =>
					Array.isArray(value) ? value : value == null ? [] : [value],
				)
				.map((value) =>
					typeof value === "string"
						? value
						: value &&
							  typeof value === "object" &&
							  !Array.isArray(value) &&
							  typeof value.sha === "string"
							? value.sha
							: "",
				)
				.map((value) => value.trim().toLowerCase())
				.filter((value) => SHA.test(value)),
		),
	].slice(0, 20);
	const base =
		typeof metadata.baseSha === "string"
			? metadata.baseSha.trim().toLowerCase()
			: "";
	return { commitShas, baseSha: SHA.test(base) ? base : null };
}

async function stableUuid(key: string) {
	const bytes = new Uint8Array(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)),
	);
	bytes[6] = (bytes[6]! & 15) | 80;
	bytes[8] = (bytes[8]! & 63) | 128;
	const s = [...bytes.slice(0, 16)]
		.map((x) => x.toString(16).padStart(2, "0"))
		.join("");
	return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/** Records each newly settled dispatcher Attempt once; reconciliation does the rest. */
export async function captureDispatcherWorkAttempts(
	context: BaseContext,
	organizationId: string,
	policy: KernelRequestPolicy,
) {
	if (!policy.workAttemptDelivery) return 0;
	const now = new Date().toISOString();
	const attempts = await listUncapturedDispatcherAttempts(context.db, {
		organizationId,
		since: new Date(
			Date.now() - DISPATCHER_ATTEMPT_CAPTURE_LOOKBACK_MS,
		).toISOString(),
		limit: 20,
	});
	for (const attempt of attempts)
		await receiveKernelRequest(context.db, {
			id: `attempt:${attempt.id}`,
			organizationId,
			ownerUserId: attempt.executorId,
			sourceKind: "work_attempt",
			sourceId: attempt.id,
			snapshot: { ...receivedKernelRequest(), workItemId: attempt.workItemId },
			nextOwner: policy.nextOwner,
			nextAction: "file_request",
			nextDueAt: now,
			lastEventId: `attempt:${attempt.id}:1`,
			createdAt: now,
			updatedAt: now,
		});
	return attempts.length;
}

/**
 * Completion seam for verified dispatcher Work.
 *
 * Completing Work requires an active owner/admin user or the Work's own
 * accountable/steward tedi (`workItemStewardActor`). The maintenance tick has
 * neither and must not mint one. Until a narrow steward authority is approved,
 * this only reports whether the Work is still open; verified Work stays
 * accepted with its receipt, and its request waits on `ready_to_complete` so it
 * drains on the first tick after that authority exists.
 */
export async function completeVerifiedDispatcherWork(
	context: BaseContext,
	p: { organizationId: string; workItemId: string },
): Promise<{
	status: "completed" | "already_closed" | "steward_authority_required";
}> {
	const work = await getWorkItemById(
		context.db,
		p.workItemId,
		p.organizationId,
	);
	if (
		!work ||
		work.disposition === "completed" ||
		work.disposition === "cancelled"
	)
		return { status: "already_closed" };
	return { status: "steward_authority_required" };
}

class StewardAuthorityPending extends Error {}

const notApplicable = async (): Promise<never> => {
	throw new Error("Not a dispatcher delivery check");
};

/**
 * Pass needs three recorded facts: the SHA reached main after this Attempt
 * started (and outside its base), and the deployed revision's push is at or
 * after it. Main moving past the SHA still passes. Absent facts stay unknown
 * until the window closes, then fail.
 */
export function workCommitDeliveryReader(
	context: BaseContext,
	scope: { organizationId: string },
	attempt: Pick<WorkAttempt, "startedAt" | "finishedAt" | "heartbeatAt">,
	delivery: NonNullable<KernelRequestPolicy["workAttemptDelivery"]>,
): KernelAcceptanceReader {
	return {
		readOutputRevision: notApplicable,
		readRepositoryDelivery: notApplicable,
		async readWorkCommitDelivery(check) {
			const sha = check.commitSha!;
			const deployed = String(context.env?.GIT_SHA ?? "").toLowerCase();
			const deployedSha = SHA.test(deployed) ? deployed : null;
			const rows = await findRepositoryPushObservations(context.db, {
				orgId: scope.organizationId,
				projectId: delivery.observerProjectId,
				shas: [sha, check.baseSha, deployedSha].filter((s): s is string => !!s),
				since: new Date(
					Date.parse(attempt.startedAt) - PUSH_LOOKBACK_MS,
				).toISOString(),
			});
			const carrying = (target: string) =>
				rows.find((r) => r.sha === target || r.commitShas.includes(target));
			const landed = carrying(sha);
			const refs = (...found: (typeof landed)[]) =>
				found.flatMap((r) =>
					r
						? [
								`repository-observation:${r.id}`,
								...(r.evidenceUrl ? [r.evidenceUrl] : []),
							]
						: [],
				);
			const elapsed =
				Date.now() >
				Date.parse(attempt.finishedAt ?? attempt.heartbeatAt) +
					delivery.verifyWindowMs;
			const pending = (why: string, ...found: (typeof landed)[]) => ({
				status: elapsed ? ("fail" as const) : ("unknown" as const),
				observedVersion: deployedSha,
				evidenceRefs: refs(...found),
				limitations: elapsed ? `${why} within the verification window` : why,
			});
			const fail = (why: string) => ({
				status: "fail" as const,
				observedVersion: deployedSha,
				evidenceRefs: refs(landed),
				limitations: why,
			});
			if (!landed) return pending("Commit not observed on main");
			if (Date.parse(landed.createdAt) < Date.parse(attempt.startedAt))
				return fail("Commit was already on main before this Attempt started");
			const base = check.baseSha ? carrying(check.baseSha) : undefined;
			if (
				check.baseSha === sha ||
				(base && Date.parse(landed.createdAt) <= Date.parse(base.createdAt))
			)
				return fail("Commit is contained in the Attempt's base revision");
			if (!deployedSha) return pending("Deployed revision unavailable", landed);
			const live = carrying(deployedSha);
			if (
				!live ||
				(live.id !== landed.id &&
					Date.parse(live.createdAt) < Date.parse(landed.createdAt) &&
					live.beforeSha !== landed.sha)
			)
				return pending(
					"Commit is on main but not yet in the deployed revision",
					landed,
				);
			return {
				status: "pass" as const,
				observedVersion: deployedSha,
				evidenceRefs: refs(landed, live === landed ? undefined : live),
				limitations:
					"Deployed revision is this API Worker's build; main ancestry comes from recorded pushes",
			};
		},
	};
}

function deliveryChecks(
	attempt: WorkAttempt,
	workKind: string,
): KernelAcceptanceCheck[] | null {
	if (attempt.outcome !== "succeeded") return [];
	const { commitShas, baseSha } = settledCommitShas(attempt.metadata);
	if (commitShas.length)
		return commitShas.map((commitSha) => ({
			kind: "work_commit_delivery" as const,
			commitSha,
			baseSha,
		}));
	return workKind === "coding"
		? [{ kind: "work_commit_delivery", commitSha: null, baseSha }]
		: null;
}

export async function reconcileWorkAttemptKernelRequest(
	context: BaseContext,
	initial: KernelRequestRow,
	policy: KernelRequestPolicy,
) {
	let row = initial;
	const delivery = policy.workAttemptDelivery;
	const workItemId = row.snapshot.workItemId;
	if (
		row.sourceKind !== "work_attempt" ||
		!delivery ||
		!workItemId ||
		row.snapshot.state === "learned" ||
		row.snapshot.state === "cancelled"
	)
		return row;
	const db = context.db;
	const now = () => new Date().toISOString();
	const apply = async (event: KernelRequestEvent) =>
		(row = await applyKernelRequestEvent(db, row, event, policy, now()));
	const [work, history] = await Promise.all([
		getWorkItemById(db, workItemId, row.organizationId),
		listWorkItemAttempts(db, {
			orgId: row.organizationId,
			workItemId,
			limit: 20,
		}).then((page) => page.data),
	]);
	const attempt = history.find((a) => a.id === row.sourceId);
	if (!work || !attempt?.outcome) return row;
	if (row.snapshot.state === "received")
		await apply({ kind: "file", workItemId });
	if (row.snapshot.state === "filed") {
		const checks = deliveryChecks(attempt, work.workKind);
		// Non-code Work with no commit has nothing for this tracker to verify.
		if (!checks) return apply({ kind: "cancel", attemptId: null });
		await apply({ kind: "brief", revision: 1, checks });
	}
	if (row.snapshot.state === "briefed")
		await apply({ kind: "start", attemptId: attempt.id });
	const reader = workCommitDeliveryReader(context, row, attempt, delivery);
	const drive = async () => {
		try {
			row =
				(await driveKernelRequest(
					db,
					row,
					policy,
					{
						readExecution: async () => ({
							attemptId: attempt.id,
							outcome:
								attempt.outcome === "expired" ? "failed" : attempt.outcome,
						}),
						deliverReport: (current) =>
							recordVerifiedDelivery(context, current, attempt.id, workItemId),
					},
					reader,
					now,
				)) ?? row;
			return true;
		} catch (error) {
			if (!(error instanceof StewardAuthorityPending)) throw error;
			const current = (await getKernelRequest(db, row)) ?? row;
			row =
				(await transitionKernelRequest(db, {
					...current,
					expectedVersion: current.version,
					eventId: `${current.id}:${current.version + 1}`,
					nextAction: "ready_to_complete",
					nextDueAt: new Date(Date.now() + policy.retryMs).toISOString(),
					now: now(),
				})) ?? current;
			return false;
		}
	};
	if (!(await drive())) return row;
	const s = row.snapshot;
	if (s.state !== "verifying" || s.delivery || !s.acceptanceKey) return row;
	if (
		s.outcome === "unknown" &&
		(s.probeAttempts ?? 0) >= policy.maxProbeAttempts
	) {
		// The probe budget is shared with Home; the delivery window decides here.
		const windowClosed =
			Date.now() >
			Date.parse(attempt.finishedAt ?? attempt.heartbeatAt) +
				delivery.verifyWindowMs;
		if (!windowClosed) return row;
		const observations = await runKernelAcceptanceChecks(s.checks, reader, now);
		await apply({
			kind: "checked",
			acceptanceKey: s.acceptanceKey,
			observations: observations.map((o) =>
				o.status === "unknown"
					? {
							...o,
							status: "fail",
							limitations: `${o.limitations ?? "Unverified"}; verification window closed`,
						}
					: o,
			),
		});
		if (row.snapshot.outcome === "verified") {
			await apply({
				kind: "delivery_intent",
				intentId: `${s.acceptanceKey}:report`,
			});
			await drive();
			return row;
		}
	}
	if (row.snapshot.outcome !== "failed") return row;
	const superseded = history[0] && history[0].id !== attempt.id;
	let receiptRef: string;
	if (
		superseded ||
		work.disposition === "completed" ||
		work.disposition === "cancelled"
	)
		receiptRef = `no-repair:${superseded ? "superseded" : work.disposition}`;
	else {
		const reasons = row.snapshot.observations
			.filter((o) => o.status !== "pass")
			.map((o) => o.limitations ?? "unverified");
		const repair = await proposeWorkDeliveryRepair(db, {
			id: await stableUuid(
				`delivery-repair:${row.organizationId}:${workItemId}`,
			),
			workItem: work,
			failedAttemptId: attempt.id,
			reason:
				attempt.outcome === "succeeded"
					? `Settled succeeded but delivery not verified: ${reasons.join("; ")}`
					: `Attempt ${attempt.outcome}: ${attempt.summary ?? "no summary"}`,
			now: now(),
		});
		if (!repair) return row;
		receiptRef = `work-repair:${repair.id}`;
	}
	const intentId = `${row.snapshot.acceptanceKey}:repair`;
	await apply({ kind: "delivery_intent", intentId });
	await apply({
		kind: "delivered",
		intentId,
		status: "acknowledged",
		receiptRef,
	});
	return apply({ kind: "learn", disposition: "no_new_lesson" });
}

/** Writes the verified receipt once, then asks the completion seam. */
async function recordVerifiedDelivery(
	context: BaseContext,
	current: KernelRequestRow,
	attemptId: string,
	workItemId: string,
) {
	const shas = current.snapshot.checks.flatMap((c) =>
		c.kind === "work_commit_delivery" && c.commitSha ? [c.commitSha] : [],
	);
	const evidenceRefs = current.snapshot.observations.flatMap(
		(o) => o.evidenceRefs,
	);
	const deployed = current.snapshot.observations[0]?.observedVersion;
	await addWorkItemCommentIfAbsent(context.db, {
		id: `${current.id}:verified`,
		orgId: current.organizationId,
		workItemId,
		authorType: "system",
		authorId: "request-tracker",
		body: `Delivery verified for Attempt ${attemptId}: ${shas.join(", ")} reached main after the Attempt started and is in deployed revision ${deployed ?? "unknown"}. Next action: ready to complete. Evidence: ${evidenceRefs.join(", ")}`,
		metadata: {
			deliveryVerification: {
				status: "ready_to_complete",
				requestId: current.id,
				attemptId,
				commitShas: shas,
				deployedSha: deployed ?? null,
				evidenceRefs,
			},
		},
		createdAt: new Date().toISOString(),
	});
	const completion = await completeVerifiedDispatcherWork(context, {
		organizationId: current.organizationId,
		workItemId,
	});
	if (completion.status === "steward_authority_required")
		throw new StewardAuthorityPending();
	return {
		status: "acknowledged" as const,
		receiptRef: `work-delivery:${current.id}:${completion.status}`,
	};
}
