import {
	KernelRequestSnapshotSchema,
	type KernelAcceptanceCheck,
	type KernelAcceptanceObservation,
	type KernelRequestSnapshot,
} from "@tedix/api-contract/schemas/kernel-request";

export type KernelRequestEvent =
	| { kind: "file"; workItemId: string }
	| { kind: "brief"; revision: number; checks: KernelAcceptanceCheck[] }
	| { kind: "start"; attemptId: string }
	| {
			kind: "terminal";
			attemptId: string;
			outcome: "succeeded" | "failed" | "cancelled";
	  }
	| {
			kind: "checked";
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
		case "file":
			if (s.state === "received")
				patch = { state: "filed", workItemId: event.workItemId };
			break;
		case "brief":
			if (
				(s.state === "filed" || s.state === "verifying") &&
				event.revision > s.briefRevision
			)
				patch = {
					state: "briefed",
					briefRevision: event.revision,
					checks: event.checks,
					attemptId: null,
					acceptanceKey: null,
					observations: [],
					outcome: null,
					delivery: null,
				};
			break;
		case "start":
			if (s.state === "briefed")
				patch = { state: "running", attemptId: event.attemptId };
			break;
		case "terminal":
			if (s.state === "running" && s.attemptId === event.attemptId)
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
			if (
				s.state === "verifying" &&
				s.acceptanceKey === event.acceptanceKey &&
				!s.delivery
			) {
				const complete =
					s.checks.length > 0 &&
					event.observations.length === s.checks.length &&
					s.checks.every(
						(_, i) =>
							event.observations.filter((o) => o.checkIndex === i).length === 1,
					);
				patch = {
					observations: event.observations,
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
			if (s.attemptId === event.attemptId) patch = { state: "cancelled" };
			break;
	}
	return patch
		? KernelRequestSnapshotSchema.parse({ ...s, ...patch })
		: current;
}

export interface KernelAcceptanceReader {
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
