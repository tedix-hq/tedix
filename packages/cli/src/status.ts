import type { TediRunStatus } from "@tedix/api-contract/schemas/cognitive-runtime";
import {
	type HomeRunSummary,
	isPendingHomeApproval,
	stringValue,
	summarizeHomePayload,
} from "./home-client";
import { isRecord } from "@tedix/api-contract/utils/is-record";

/**
 * Compact operator dashboard built purely from already-fetched gateway reads.
 *
 * The orchestrator fetches a `read_home_run_set` payload (and optionally a
 * `read_child_run_tree` payload) via `TedixHomeClient` and hands the raw,
 * unwrapped payload objects to these PURE functions — there is no network here.
 * Every field access is guarded; a malformed payload yields empty buckets
 * rather than a throw (fail-soft, with a console.error diagnostic).
 */
export interface StatusReport {
	errors?: string[];
	conversationId: string;
	activeRuns: Array<{
		homeRunId: string;
		status: string;
		label?: string;
		targetTedi?: string;
	}>;
	pendingApprovals: Array<{ homeRunId: string; summary?: string }>;
	recentDelegations: Array<{
		tedi: string;
		childRunId: string;
		status?: string;
		preview?: string;
	}>;
}

/**
 * Terminal/settled run statuses. Re-derived locally rather than reusing
 * `isSettledHomeStatus`: that helper counts `requires_approval` as settled, but
 * an operator dashboard wants approval-blocked runs to surface as ACTIVE (they
 * still need a human). A run is active when it carries a non-empty status that
 * is not one of these terminal values (so queued / running / requires_approval
 * / waiting / active all qualify).
 */
export const TERMINAL_STATUSES = new Set<TediRunStatus>([
	"completed",
	"failed",
	"canceled",
]);

function isActiveStatus(status: string | undefined): boolean {
	return (
		status !== undefined &&
		!(TERMINAL_STATUSES as ReadonlySet<string>).has(status)
	);
}

/**
 * Recursively locate the run array inside a `read_home_run_set` payload. The
 * canonical shape is `{ runSet: { runs: [...], activeRunIds: [...] } }`, but we
 * tolerate a flatter `{ runs: [...] }` or common container keys, mirroring the
 * defensiveness of `latestRunFromSet`. Returns only record entries.
 */
function findRunsArray(payload: unknown): Record<string, unknown>[] {
	if (Array.isArray(payload)) {
		const records = payload.filter(isRecord);
		return records.some(
			(entry) =>
				"id" in entry ||
				"homeRunId" in entry ||
				"runId" in entry ||
				"status" in entry,
		)
			? records
			: [];
	}
	if (!isRecord(payload)) return [];
	for (const key of ["runs", "data", "items", "results"]) {
		const found = findRunsArray(payload[key]);
		if (found.length > 0) return found;
	}
	for (const value of Object.values(payload)) {
		const found = findRunsArray(value);
		if (found.length > 0) return found;
	}
	return [];
}

/** Flatten a `read_child_run_tree` payload into a flat list of nodes. */
function flattenTreeNodes(payload: unknown): Record<string, unknown>[] {
	const root = isRecord(payload) ? payload : {};
	const tree = isRecord(root.tree) ? root.tree : root;
	const nodes = Array.isArray(tree.nodes) ? tree.nodes : [];
	const out: Record<string, unknown>[] = [];
	const walk = (list: unknown[]) => {
		for (const node of list) {
			if (!isRecord(node)) continue;
			out.push(node);
			if (Array.isArray(node.children)) walk(node.children);
		}
	};
	walk(nodes);
	return out;
}

function nodePreview(node: Record<string, unknown>): string | undefined {
	const progress = isRecord(node.progress) ? node.progress : {};
	return (
		stringValue(node.preview) ??
		stringValue(node.childRunPreview) ??
		stringValue(node.summary) ??
		stringValue(progress.detail) ??
		stringValue(progress.label)
	);
}

function targetTediOf(summary: HomeRunSummary): string | undefined {
	return (
		summary.targetTediLabel ?? summary.targetTediId ?? summary.delegatedTediId
	);
}

function routeKindOf(summary: HomeRunSummary): string | undefined {
	return isRecord(summary.kernelRoute)
		? stringValue(summary.kernelRoute.routeKind)
		: undefined;
}

/**
 * Pure: parse a `read_home_run_set` payload (+ optional `read_child_run_tree`
 * payload) into a {@link StatusReport}. Never throws — any unexpected failure
 * yields empty buckets with a console.error diagnostic.
 */
export function buildStatusReport(input: {
	conversationId: string;
	runSet: unknown;
	childTree?: unknown;
	errors?: string[];
}): StatusReport {
	const conversationId = input.conversationId;
	try {
		// Wrap each row in the run envelope expected by summarizeHomePayload.
		const summaries: HomeRunSummary[] = [];
		for (const row of findRunsArray(input.runSet)) {
			const summary = summarizeHomePayload({ run: row });
			if (summary) summaries.push(summary);
		}

		const activeRuns: StatusReport["activeRuns"] = [];
		const pendingApprovals: StatusReport["pendingApprovals"] = [];
		for (const summary of summaries) {
			const pendingApproval = isPendingHomeApproval(summary);
			if (isActiveStatus(summary.status) || pendingApproval) {
				const target = targetTediOf(summary);
				activeRuns.push({
					homeRunId: summary.homeRunId,
					// Project a live operator decision as an approval gate.
					status: pendingApproval
						? "requires_approval"
						: (summary.status ?? ""),
					...(pendingApproval
						? { label: "Awaiting approval" }
						: summary.progressLabel
							? { label: summary.progressLabel }
							: {}),
					...(target ? { targetTedi: target } : {}),
				});
			}
			if (pendingApproval) {
				const text =
					summary.delegationObjective ??
					summary.progressLabel ??
					(summary.assistantText || undefined) ??
					routeKindOf(summary);
				pendingApprovals.push({
					homeRunId: summary.homeRunId,
					...(text ? { summary: text } : {}),
				});
			}
		}

		// Delegations: prefer the child-tree projection (per-tedi child runs) when
		// it carries any; otherwise fall back to run rows carrying both a
		// delegatedTediId and a childRunId. A present-but-empty tree falls through
		// so run-level delegations are not hidden.
		const treeDelegations: StatusReport["recentDelegations"] = [];
		for (const node of flattenTreeNodes(input.childTree)) {
			const childRunId = stringValue(node.childRunId);
			if (!childRunId) continue;
			const preview = nodePreview(node);
			treeDelegations.push({
				tedi:
					stringValue(node.label) ??
					stringValue(node.delegatedTediId) ??
					"unknown",
				childRunId,
				...(stringValue(node.status)
					? { status: stringValue(node.status) }
					: {}),
				...(preview ? { preview } : {}),
			});
		}

		const runDelegations: StatusReport["recentDelegations"] = [];
		for (const summary of summaries) {
			if (!summary.delegatedTediId || !summary.childRunId) continue;
			const preview =
				summary.childRunPreview ?? (summary.assistantText || undefined);
			runDelegations.push({
				tedi: summary.targetTediLabel ?? summary.delegatedTediId,
				childRunId: summary.childRunId,
				...(summary.status ? { status: summary.status } : {}),
				...(preview ? { preview } : {}),
			});
		}

		const recentDelegations =
			treeDelegations.length > 0 ? treeDelegations : runDelegations;

		return {
			conversationId,
			activeRuns,
			pendingApprovals,
			recentDelegations,
			...(input.errors?.length ? { errors: input.errors } : {}),
		};
	} catch (error) {
		console.error("[status] failed to build status report:", error);
		return {
			conversationId,
			errors: [...(input.errors ?? []), "Could not interpret status data"],
			activeRuns: [],
			pendingApprovals: [],
			recentDelegations: [],
		};
	}
}

/**
 * Pure: render a {@link StatusReport} for the terminal. `json:true` emits pretty
 * JSON of the report; otherwise a compact, plain-text human block whose header
 * reflects the bucket counts. No ANSI/color is emitted here so callers can pipe
 * or wrap it freely.
 */
export function renderStatusReport(
	report: StatusReport,
	opts: { json: boolean },
): string {
	if (opts.json) return JSON.stringify(report, null, 2);

	const lines: string[] = [];
	if (report.errors?.length)
		lines.push(
			"Status incomplete",
			...report.errors.map((error) => `  ${error}`),
			"",
		);
	lines.push(`status conversation=${report.conversationId || "unknown"}`);
	lines.push(
		`active=${report.activeRuns.length} approvals=${report.pendingApprovals.length} delegations=${report.recentDelegations.length}`,
	);

	lines.push("");
	lines.push("active runs:");
	if (report.activeRuns.length === 0) {
		lines.push(
			report.errors?.length
				? "  (no confirmed results; status incomplete)"
				: "  (none)",
		);
	} else {
		for (const run of report.activeRuns) {
			const parts = [
				run.homeRunId,
				`status=${run.status || "unknown"}`,
				run.label ? `label=${run.label}` : null,
				run.targetTedi ? `→ ${run.targetTedi}` : null,
			].filter(Boolean);
			lines.push(`  ${parts.join("  ")}`);
		}
	}

	lines.push("pending approvals:");
	if (report.pendingApprovals.length === 0) {
		lines.push(
			report.errors?.length
				? "  (no confirmed results; status incomplete)"
				: "  (none)",
		);
	} else {
		for (const approval of report.pendingApprovals) {
			const parts = [
				approval.homeRunId,
				approval.summary ? approval.summary : null,
			].filter(Boolean);
			lines.push(`  ${parts.join("  ")}`);
		}
	}

	lines.push("recent delegations:");
	if (report.recentDelegations.length === 0) {
		lines.push(
			report.errors?.length
				? "  (no confirmed results; status incomplete)"
				: "  (none)",
		);
	} else {
		const MAX_DELEGATIONS = 8;
		for (const delegation of report.recentDelegations.slice(
			0,
			MAX_DELEGATIONS,
		)) {
			const parts = [
				delegation.tedi,
				`child=${delegation.childRunId}`,
				delegation.status ? `status=${delegation.status}` : null,
				delegation.preview ? delegation.preview : null,
			].filter(Boolean);
			lines.push(`  ${parts.join("  ")}`);
		}
		if (report.recentDelegations.length > MAX_DELEGATIONS) {
			lines.push(
				`  … (${report.recentDelegations.length - MAX_DELEGATIONS} more)`,
			);
		}
	}

	return lines.join("\n");
}
