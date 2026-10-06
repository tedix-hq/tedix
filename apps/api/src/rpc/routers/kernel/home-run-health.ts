import type {
	HomeRunConvergenceHealth,
	HomeRunTrace,
	HomeRunTraceBranch,
} from "@tedix/api-contract/schemas/kernel-runtime";

const TERMINAL_CHILD_STATUSES = new Set([
	"completed",
	"partial",
	"failed",
	"canceled",
]);

export const HOME_RUN_CONVERGENCE_HEALTH_CODES = [
	"terminal_child_without_wake",
	"acknowledged_wake_without_synthesis",
	"parent_completed_with_required_child_active",
	"child_evidence_missing",
	"child_evidence_truncated",
	"orphaned_workstation_reference",
	"repeated_synthesis_failures",
	"repeated_redrive_failures",
] as const;

export type HomeRunConvergenceHealthCode =
	(typeof HOME_RUN_CONVERGENCE_HEALTH_CODES)[number];

export type HomeRunConvergenceHealthFinding = {
	code: HomeRunConvergenceHealthCode;
	severity: "error" | "warning";
	childRunId: string | null;
	referenceId: string | null;
	detail: string;
};

/**
 * A durable workstation row or mapping that claims membership in this Home
 * run. The trace reader owns loading these references from their canonical
 * tables; this evaluator only checks whether each reference joins to a branch.
 */
export type HomeRunWorkstationReference = {
	id: string;
	childRunId?: string | null;
	workItemId?: string | null;
};

export type HomeRunConvergenceHealthInput = {
	trace: Pick<
		HomeRunTrace,
		"status" | "branches" | "wakeReceipts" | "synthesis"
	>;
	/** All branches are required unless the plan explicitly marks a subset. */
	requiredChildRunIds?: readonly string[];
	workstationReferences?: readonly HomeRunWorkstationReference[];
	/** Persisted synthesis failure attempts, when the runtime records them. */
	synthesisFailureCount?: number;
	/** Persisted planner/recovery redrive count from the parent run metadata. */
	redriveCount?: number;
	/** Two failed attempts is actionable while one remains ordinary retrying. */
	repeatedFailureThreshold?: number;
};

export function isTerminalHomeRunTraceBranchStatus(
	status: HomeRunTraceBranch["status"],
): boolean {
	return TERMINAL_CHILD_STATUSES.has(status);
}

function isTerminalBranch(branch: HomeRunTraceBranch): boolean {
	return isTerminalHomeRunTraceBranchStatus(branch.status);
}

function branchMatchesWorkstationReference(
	branch: HomeRunTraceBranch,
	reference: HomeRunWorkstationReference,
): boolean {
	if (
		reference.childRunId &&
		branch.observedRunIds.includes(reference.childRunId)
	) {
		return true;
	}
	return Boolean(
		reference.workItemId && branch.workItemId === reference.workItemId,
	);
}

/**
 * Deterministically evaluate convergence integrity over already-assembled
 * canonical evidence. This is intentionally not an Observer/Reflector model
 * pass: ledger invariants must be reproducible, bounded, and free of LLM
 * judgment.
 */
export function evaluateHomeRunConvergenceHealth(
	input: HomeRunConvergenceHealthInput,
): HomeRunConvergenceHealth {
	const findings: HomeRunConvergenceHealthFinding[] = [];
	const parentCanceled = input.trace.status === "canceled";
	const branchByChildRunId = new Map(
		input.trace.branches.map((branch) => [branch.childRunId, branch]),
	);
	const wakesByChildRunId = new Map<string, typeof input.trace.wakeReceipts>();
	for (const receipt of input.trace.wakeReceipts) {
		const receipts = wakesByChildRunId.get(receipt.childRunId) ?? [];
		receipts.push(receipt);
		wakesByChildRunId.set(receipt.childRunId, receipts);
	}
	const synthesizedChildRunIds = new Set(
		input.trace.synthesis.flatMap((item) => item.childRunIds),
	);

	for (const branch of input.trace.branches) {
		const receipts = wakesByChildRunId.get(branch.childRunId) ?? [];
		if (!parentCanceled && isTerminalBranch(branch) && receipts.length === 0) {
			findings.push({
				code: "terminal_child_without_wake",
				severity: "error",
				childRunId: branch.childRunId,
				referenceId: branch.terminalEventId,
				detail: "Terminal child evidence has no durable Kernel wake receipt.",
			});
		}
		if (!branch.evidenceAvailable) {
			findings.push({
				code: "child_evidence_missing",
				severity: "error",
				childRunId: branch.childRunId,
				referenceId: null,
				detail:
					"The delegated branch has no runtime event or artifact evidence.",
			});
		}
		if (branch.truncated) {
			findings.push({
				code: "child_evidence_truncated",
				severity: "warning",
				childRunId: branch.childRunId,
				referenceId: branch.eventIds.at(-1) ?? null,
				detail: "The bounded trace hit a child event or artifact limit.",
			});
		}
	}

	const parentTerminal = TERMINAL_CHILD_STATUSES.has(input.trace.status);
	for (const receipt of input.trace.wakeReceipts) {
		if (
			parentTerminal &&
			!parentCanceled &&
			receipt.ackedAt &&
			!synthesizedChildRunIds.has(receipt.childRunId)
		) {
			findings.push({
				code: "acknowledged_wake_without_synthesis",
				severity: "error",
				childRunId: receipt.childRunId,
				referenceId: receipt.id,
				detail:
					"The Kernel acknowledged this wake but no synthesis references its child run.",
			});
		}
	}

	if (input.trace.status === "completed") {
		const requiredChildRunIds =
			input.requiredChildRunIds ??
			input.trace.branches.map((branch) => branch.childRunId);
		for (const childRunId of new Set(requiredChildRunIds)) {
			const branch = branchByChildRunId.get(childRunId);
			if (branch && !isTerminalBranch(branch)) {
				findings.push({
					code: "parent_completed_with_required_child_active",
					severity: "error",
					childRunId,
					referenceId: null,
					detail:
						"The parent is completed while a required child branch remains active.",
				});
			}
		}
	}

	for (const reference of input.workstationReferences ?? []) {
		if (
			!input.trace.branches.some((branch) =>
				branchMatchesWorkstationReference(branch, reference),
			)
		) {
			findings.push({
				code: "orphaned_workstation_reference",
				severity: "error",
				childRunId: reference.childRunId ?? null,
				referenceId: reference.id,
				detail:
					"A workstation reference cannot be joined to a delegated branch by run or Work Item.",
			});
		}
	}

	const repeatedFailureThreshold = Math.max(
		2,
		Math.trunc(input.repeatedFailureThreshold ?? 2),
	);
	const unsynthesizedAckCount = input.trace.wakeReceipts.filter(
		(receipt) =>
			parentTerminal &&
			!parentCanceled &&
			Boolean(receipt.ackedAt) &&
			!synthesizedChildRunIds.has(receipt.childRunId),
	).length;
	const synthesisFailureCount = Math.max(
		0,
		Math.trunc(input.synthesisFailureCount ?? 0),
		unsynthesizedAckCount,
	);
	if (synthesisFailureCount >= repeatedFailureThreshold) {
		findings.push({
			code: "repeated_synthesis_failures",
			severity: "error",
			childRunId: null,
			referenceId: null,
			detail: `Synthesis convergence failed ${synthesisFailureCount} times (threshold ${repeatedFailureThreshold}).`,
		});
	}
	const redriveCount = Math.max(0, Math.trunc(input.redriveCount ?? 0));
	if (redriveCount >= repeatedFailureThreshold) {
		findings.push({
			code: "repeated_redrive_failures",
			severity: "error",
			childRunId: null,
			referenceId: null,
			detail: `The parent required ${redriveCount} recovery redrives (threshold ${repeatedFailureThreshold}).`,
		});
	}

	const errors = findings.filter(
		(finding) => finding.severity === "error",
	).length;
	const warnings = findings.length - errors;
	return {
		status: errors > 0 ? "unhealthy" : warnings > 0 ? "degraded" : "healthy",
		findings,
		counts: { errors, warnings },
	};
}
