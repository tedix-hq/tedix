import type { LaneCheckpoint } from "@tedix/api-contract/schemas/lane-execution";
import {
	KernelRequestSnapshotSchema,
	KernelWorkOrderSchema,
	type KernelWorkOrder,
	type KernelAcceptanceCheck,
	type KernelAcceptanceObservation,
	type KernelRequestSnapshot,
} from "@tedix/api-contract/schemas/kernel-request";

/** Called only after the adapter resolves canonical Work under its existing source ACL. */
export function kernelWorkOrder(
	work: {
		id: string;
		version: number;
		title: string;
		description: string | null;
		acceptanceContract: { doneLooksLike?: string } | null;
		requiredCapabilities: string[];
		requiredAuthorities: string[];
	},
	checks: KernelAcceptanceCheck[],
	destination: KernelWorkOrder["destination"],
): KernelWorkOrder {
	const citation = `work:${work.id}@${work.version}`;
	return KernelWorkOrderSchema.parse({
		version: 1,
		workItemId: work.id,
		workVersion: work.version,
		goal: work.title,
		facts: work.description
			? [{ text: work.description, status: "reported", citation }]
			: [],
		citations: [citation],
		constraints: work.requiredAuthorities.map(
			(authority) => `Required authority (not granted): ${authority}`,
		),
		requiredCapabilities: work.requiredCapabilities,
		acceptance: {
			doneLooksLike: work.acceptanceContract?.doneLooksLike ?? null,
			checks,
		},
		destination,
	});
}

export function kernelRequestReportMessageId(sourceId: string): string {
	return `${sourceId}:acceptance:assistant`;
}

/** Keep the source reply short; full observations stay in its private metadata. */
export function kernelRequestAcceptanceReport(
	snapshot: KernelRequestSnapshot,
	workItemId: string,
): string {
	const s = KernelRequestSnapshotSchema.parse(snapshot);
	if (
		s.outcome !== "verified" ||
		!s.checks.length ||
		s.observations.length !== s.checks.length ||
		s.observations.some((observation) => observation.status !== "pass")
	)
		throw new Error("Acceptance report requires verified checks");
	return `Verified ${s.checks.length} acceptance ${s.checks.length === 1 ? "check" : "checks"} for this request. [Open the Work item](/work/items/${encodeURIComponent(workItemId)}). Detailed check receipts are retained in this conversation.`;
}

export type KernelRequestEvent =
	| { kind: "lane_checkpoint"; checkpoint: LaneCheckpoint }
	| { kind: "file"; workItemId: string | null }
	| {
			kind: "brief";
			revision: number;
			checks: KernelAcceptanceCheck[];
			workOrder?: KernelWorkOrder;
	  }
	| { kind: "start"; attemptId: string }
	| { kind: "successor"; previousAttemptId: string; attemptId: string }
	| {
			kind: "terminal";
			attemptId: string;
			outcome: "succeeded" | "failed" | "cancelled";
	  }
	| {
			kind: "checked" | "rechecked";
			acceptanceKey: string;
			observations: KernelAcceptanceObservation[];
	  }
	| { kind: "delivery_intent"; intentId: string }
	| {
			kind: "delivered";
			intentId: string;
			status: "acknowledged" | "unavailable";
			receiptRef: string;
	  }
	| { kind: "learn"; disposition: "lesson_saved" | "no_new_lesson" }
	| { kind: "cancel"; attemptId: string | null };

export function receivedKernelRequest(): KernelRequestSnapshot {
	return {
		state: "received",
		workItemId: null,
		attemptId: null,
		briefRevision: 0,
		checks: [],
		acceptanceKey: null,
		observations: [],
		outcome: null,
		delivery: null,
		learning: null,
	};
}

/** Stale and duplicate events are no-ops; source readers, not executors, produce observations. */
export function advanceKernelRequest(
	requestId: string,
	current: KernelRequestSnapshot,
	event: KernelRequestEvent,
): KernelRequestSnapshot {
	const s = KernelRequestSnapshotSchema.parse(current);
	if (s.state === "learned" || s.state === "cancelled") return current;
	let patch: Partial<KernelRequestSnapshot> | null = null;
	switch (event.kind) {
		case "lane_checkpoint": {
			const prior = s.laneCheckpoint;
			const allowed =
				!prior || prior.previousAttemptId !== s.attemptId
					? event.checkpoint.status === "reconcile"
					: prior.key === event.checkpoint.key &&
						(
							{
								reconcile: ["ready", "held"],
								ready: ["dispatching", "held"],
								dispatching: ["continued", "held"],
								continued: [],
								held: [],
							}[prior.status] as string[]
						).includes(event.checkpoint.status);
			if (
				s.state === "running" &&
				s.attemptId === event.checkpoint.previousAttemptId &&
				allowed
			)
				patch = { laneCheckpoint: event.checkpoint };
			break;
		}
		case "file":
			if (s.state === "received")
				patch = { state: "filed", workItemId: event.workItemId };
			break;
		case "brief":
			if (
				(s.state === "filed" || s.state === "verifying") &&
				event.revision > s.briefRevision &&
				(!event.workOrder || event.workOrder.workItemId === s.workItemId)
			)
				patch = {
					state: "briefed",
					briefRevision: event.revision,
					checks: event.checks,
					workOrder: event.workOrder,
					attemptId: null,
					acceptanceKey: null,
					probeAttempts: 0,
					observations: [],
					outcome: null,
					delivery: null,
				};
			break;
		case "start":
			if (s.state === "briefed")
				patch = { state: "running", attemptId: event.attemptId };
			break;
		case "successor":
			if (
				(s.state === "running" || s.state === "verifying") &&
				s.attemptId === event.previousAttemptId &&
				(!s.laneCheckpoint ||
					s.laneCheckpoint.previousAttemptId !== s.attemptId ||
					(s.laneCheckpoint.status === "continued" &&
						s.laneCheckpoint.successorAttemptId === event.attemptId))
			)
				patch = {
					state: "running",
					attemptId: event.attemptId,
					briefRevision: s.briefRevision + 1,
					acceptanceKey: null,
					observations: [],
					outcome: null,
					delivery: null,
					probeAttempts: 0,
				};
			break;
		case "terminal":
			if (
				s.state === "running" &&
				s.attemptId === event.attemptId &&
				(event.outcome === "cancelled" ||
					!s.laneCheckpoint ||
					s.laneCheckpoint.previousAttemptId !== s.attemptId)
			)
				patch =
					event.outcome === "cancelled"
						? { state: "cancelled" }
						: {
								state: "verifying",
								acceptanceKey: JSON.stringify([
									requestId,
									event.attemptId,
									s.briefRevision,
								]),
								outcome: event.outcome === "failed" ? "failed" : "unknown",
							};
			break;
		case "checked":
		case "rechecked":
			if (
				s.state === "verifying" &&
				s.acceptanceKey === event.acceptanceKey &&
				(!s.delivery ||
					(event.kind === "rechecked" && s.delivery.status === "pending"))
			) {
				const complete =
					s.checks.length > 0 &&
					event.observations.length === s.checks.length &&
					s.checks.every(
						(_, i) =>
							event.observations.filter((o) => o.checkIndex === i).length === 1,
					);
				patch = {
					...(event.kind === "rechecked" ? { delivery: null } : {}),
					observations: event.observations,
					probeAttempts: (s.probeAttempts ?? 0) + 1,
					outcome:
						s.outcome === "failed"
							? "failed"
							: event.observations.some((o) => o.status === "fail")
								? "failed"
								: complete &&
									  event.observations.every((o) => o.status === "pass")
									? "verified"
									: "unknown",
				};
			}
			break;
		case "delivery_intent":
			if (
				s.state === "verifying" &&
				s.outcome !== "unknown" &&
				s.outcome !== null &&
				!s.delivery
			)
				patch = {
					delivery: {
						intentId: event.intentId,
						status: "pending",
						receiptRef: null,
					},
				};
			break;
		case "delivered":
			if (
				s.state === "verifying" &&
				s.delivery?.intentId === event.intentId &&
				s.delivery.status === "pending"
			)
				patch = {
					state: "reported",
					delivery: {
						intentId: event.intentId,
						status: event.status,
						receiptRef: event.receiptRef,
					},
					learning: "pending",
				};
			break;
		case "learn":
			if (s.state === "reported")
				patch = { state: "learned", learning: event.disposition };
			break;
		case "cancel":
			if (s.state !== "reported" && s.attemptId === event.attemptId)
				patch = { state: "cancelled" };
			break;
	}
	return patch
		? KernelRequestSnapshotSchema.parse({ ...s, ...patch })
		: current;
}

export interface KernelAcceptanceReader {
	/** Confirms source reply delivery only, never correctness or an outside action. */
	readHomeResponse?(): Promise<{ attemptId: string; receiptRef: string }>;
	/** Must enforce the source viewer's current workspace ACL. */
	readOutputRevision(
		check: Extract<KernelAcceptanceCheck, { kind: "os_output_revision" }>,
	): Promise<{ revisionId: string; evidenceRef: string }>;
	/** Configured trusted target reader; never consumes a child's claimed success. */
	readRepositoryDelivery(
		check: Extract<KernelAcceptanceCheck, { kind: "repository_delivery" }>,
	): Promise<{
		mainSha: string;
		shipSha: string;
		shipStatus: string;
		liveSha: string;
		surface: string;
		evidenceRefs: string[];
	}>;
	/** Reads recorded main pushes and the deployed revision; never the executor's claim. */
	readWorkCommitDelivery?(
		check: Extract<KernelAcceptanceCheck, { kind: "work_commit_delivery" }>,
	): Promise<{
		status: "pass" | "fail" | "unknown";
		observedVersion: string | null;
		evidenceRefs: string[];
		limitations: string | null;
	}>;
}

/** The caller supplies bounded adapter deadlines; unavailable targets remain unknown. */
export async function runKernelAcceptanceChecks(
	checks: KernelAcceptanceCheck[],
	reader: KernelAcceptanceReader,
	now: () => string,
): Promise<KernelAcceptanceObservation[]> {
	const observations: KernelAcceptanceObservation[] = [];
	for (const [checkIndex, check] of checks.entries()) {
		const inputDigest = Array.from(
			new Uint8Array(
				await crypto.subtle.digest(
					"SHA-256",
					new TextEncoder().encode(JSON.stringify(check)),
				),
			),
		)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const base = { checkerVersion: 1 as const, checkIndex, inputDigest };
		try {
			if (check.kind === "os_output_revision") {
				const result = await reader.readOutputRevision(check);
				observations.push({
					...base,
					status: result.revisionId === check.revisionId ? "pass" : "fail",
					observedVersion: result.revisionId,
					checkedAt: now(),
					evidenceRefs: [result.evidenceRef],
					limitations: null,
				});
			} else if (check.kind === "home_response") {
				if (!reader.readHomeResponse)
					throw new Error("Home reader unavailable");
				const result = await reader.readHomeResponse();
				observations.push({
					...base,
					status: "pass",
					observedVersion: result.attemptId,
					checkedAt: now(),
					evidenceRefs: [result.receiptRef],
					limitations:
						"Confirms durable Home reply delivery only; not factual correctness or external target state",
				});
			} else if (check.kind === "work_commit_delivery") {
				if (!check.commitSha) {
					observations.push({
						...base,
						status: "fail",
						observedVersion: null,
						checkedAt: now(),
						evidenceRefs: [],
						limitations:
							"Clean exit named no commit; code Work without a commit is not a delivery",
					});
					continue;
				}
				if (!reader.readWorkCommitDelivery)
					throw new Error("Commit delivery reader unavailable");
				const result = await reader.readWorkCommitDelivery(check);
				observations.push({ ...base, ...result, checkedAt: now() });
			} else {
				const result = await reader.readRepositoryDelivery(check);
				const pass =
					result.mainSha === check.commitSha &&
					result.shipSha === check.commitSha &&
					result.shipStatus === "success" &&
					result.liveSha === check.commitSha &&
					result.surface === check.surface;
				observations.push({
					...base,
					status: pass ? "pass" : "fail",
					observedVersion: result.liveSha,
					checkedAt: now(),
					evidenceRefs: result.evidenceRefs,
					limitations: null,
				});
			}
		} catch {
			observations.push({
				...base,
				status: "unknown",
				observedVersion: null,
				checkedAt: now(),
				evidenceRefs: [],
				limitations: "Trusted target reader unavailable or access denied",
			});
		}
	}
	return observations;
}
