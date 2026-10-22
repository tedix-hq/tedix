import type { TediRuntimeEventRow } from "@tedix/db/queries/kernel-runtime-events";
import {
	classifyToolCall,
	hasExecutionEvidence,
	type TurnToolCall,
} from "@tedix/mcp-client-core/tool-liveness";
import {
	hasSuccessfulCompletionEvidence,
	hasTerminalJobCompletionEvidence,
} from "../../../services/runtime-execution-evidence";
import { nonNullRecord } from "./runtime-shared";

/**
 * Child-run LIVENESS over the same event ledger the transcript is built from:
 * a comparable EXECUTION EVIDENCE model. `toolCallCount` is how many tools the run
 * called; `hasExecutionEvidence` is true when at least one EXECUTION tool call
 * (not a discovery meta-call, not a discover-only `tedix_mcp_code` program)
 * SUCCEEDED, or a real (non-`turn_summary` bookkeeping) artifact was written.
 * Feeds the delegation proof gate so a discovery-only stall is not treated as
 * proof of completion. See `@tedix/mcp-client-core/tool-liveness`.
 */
export interface ChildRunLiveness {
	toolCallCount: number;
	hasExecutionEvidence: boolean;
	/** A terminal successful read_execution receipt was observed. */
	hasTerminalExecutionEvidence: boolean;
	/**
	 * True when the LLM's authoritative `step.completed` tool-call tally exceeds
	 * the number of `tool.started` events we could classify — i.e. a tool call
	 * ran but its `tool.started` was dropped from the ledger (the direct-path
	 * telemetry gap). Such a call is UNCLASSIFIABLE (discovery vs execution), so
	 * the proof gate must report execution evidence as UNKNOWN. Unknown evidence
	 * may trigger recovery or require a durable proof ref, but may never silently
	 * become a successful completion.
	 */
	hasUnclassifiedToolCall: boolean;
}

/**
 * Bookkeeping artifacts every run writes — NOT task-completion evidence.
 * Matched on the label's FIRST PATH SEGMENT because the runtime emits labels
 * as paths (`turn_summary/<runId>.json`); exact-matching the whole label
 * would let every run's own summary count as proof of itself.
 *
 * `workstation_process` is DELIBERATELY not in this set: unlike a
 * turn_summary (self-referential, every run emits one), a
 * `workstation_process/<pid>/...` artifact exists only when a subprocess
 * actually ran under the delegated run's workstation lease — that is real
 * execution. It feeds only the generic
 * (non-terminal) `hasExecutionEvidence`, never the terminal receipt path,
 * so a subprocess still cannot settle the child run.
 */
const BOOKKEEPING_ARTIFACT_NAMES = new Set(["turn_summary"]);
const RECEIPT_REQUIRED_EXECUTION_TOOLS = new Set([
	"tedix_mcp_code",
	"tedix_mcp_call_tool",
]);

/**
 * Derive {@link ChildRunLiveness} from DESC-ordered child event rows. Pairs each
 * `tool.started` (name + arguments → kind via `classifyToolCall`) with its
 * `tool.completed`/`tool.failed` by name + arrival order, then reuses
 * `hasExecutionEvidence`. A real artifact (not `turn_summary`) also counts.
 *
 * Cross-checks the LLM's own authoritative record: each `step.completed` carries
 * `toolCallCount` (how many tools the model actually invoked that round). If the
 * summed step tally exceeds the classifiable `tool.started` events, a tool call
 * ran unobserved — we surface {@link ChildRunLiveness.hasUnclassifiedToolCall}
 * so the gate can preserve UNKNOWN as a third state. See the direct-path
 * telemetry gap: `tedix_mcp_code` executes but its `tool.started` is dropped,
 * leaving only a `step.completed` with `toolCallCount: 1`.
 */
export function computeChildRunLiveness(
	eventRows: TediRuntimeEventRow[],
): ChildRunLiveness {
	const chronological = [...eventRows].reverse();
	const toolCalls: TurnToolCall[] = [];
	// FIFO of unresolved starts per tool name, so a completed/failed resolves the
	// oldest matching start (handles retries: a code timeout then a code success).
	const pendingByName = new Map<string, TurnToolCall[]>();
	let realArtifact = false;
	// Authoritative tool-call tally from the model's own per-round step records.
	let stepToolCallCount = 0;
	const stepToolNames: string[] = [];
	let missingExecutionReceipt = false;
	let terminalExecutionEvidence = false;

	for (const row of chronological) {
		const payload = nonNullRecord(row.payload);
		const name = typeof payload?.name === "string" ? payload.name : null;
		if (row.kind === "tool.started" && name) {
			const argsJson = JSON.stringify(payload?.arguments ?? {});
			const call: TurnToolCall = {
				name,
				ok: false,
				kind: classifyToolCall(name, argsJson),
			};
			toolCalls.push(call);
			const queue = pendingByName.get(name) ?? [];
			queue.push(call);
			pendingByName.set(name, queue);
		} else if (
			(row.kind === "tool.completed" || row.kind === "tool.failed") &&
			name
		) {
			const call = pendingByName.get(name)?.shift();
			if (call) {
				const completed = row.kind === "tool.completed";
				const result = payload?.data ?? payload?.result;
				if (completed && hasTerminalJobCompletionEvidence(result)) {
					terminalExecutionEvidence = true;
				}
				const requiresReceipt =
					call.kind === "execution" &&
					RECEIPT_REQUIRED_EXECUTION_TOOLS.has(name);
				// The EXECUTOR-attested receipt sits beside `result`, because the
				// result is the model's own projection: a Code Mode program that
				// returns `{ count: 9 }` drops the per-call `completionEvidence`
				// its tool results carried. Reading only inside `result` scored
				// every such run as a missing receipt — UNKNOWN evidence for work
				// that demonstrably ran. Same bar, evidence the gate can now see.
				const hasReceipt =
					!requiresReceipt ||
					hasSuccessfulCompletionEvidence({
						completionEvidence: payload?.completionEvidence,
					}) ||
					hasSuccessfulCompletionEvidence(result);
				call.ok = completed && hasReceipt;
				if (completed && requiresReceipt && !hasReceipt) {
					missingExecutionReceipt = true;
				}
			}
		} else if (row.kind === "step.completed") {
			const count =
				typeof payload?.toolCallCount === "number" ? payload.toolCallCount : 0;
			if (count > 0) stepToolCallCount += count;
			if (Array.isArray(payload?.toolNames)) {
				for (const toolName of payload.toolNames) {
					if (typeof toolName === "string" && toolName.length > 0) {
						stepToolNames.push(toolName);
					}
				}
			}
		} else if (row.kind === "artifact.created") {
			const artifactRecord = nonNullRecord(payload?.artifact);
			const label =
				typeof artifactRecord?.name === "string" && artifactRecord.name.trim()
					? artifactRecord.name.trim()
					: "";
			const labelHead = label.split("/", 1)[0] ?? "";
			if (label && !BOOKKEEPING_ARTIFACT_NAMES.has(labelHead)) {
				realArtifact = true;
			}
		}
	}

	// Facet-native tools can currently reach the authoritative `step.completed`
	// record without a matching `tool.started` ledger row. Reconcile the named
	// step calls against observed starts as a multiset. A missing direct tool name
	// is still classifiable from its name (`browser_execute`, `write`,
	// `tedix_mcp_call_tool`, ...), while `tedix_mcp_code` remains UNKNOWN because
	// its arguments are required to distinguish `discover.*` from real execution.
	const unmatchedStepToolNames: string[] = [];
	const remainingObservedByName = new Map<string, number>();
	for (const call of toolCalls) {
		remainingObservedByName.set(
			call.name,
			(remainingObservedByName.get(call.name) ?? 0) + 1,
		);
	}
	for (const toolName of stepToolNames) {
		const remaining = remainingObservedByName.get(toolName) ?? 0;
		if (remaining > 0) {
			remainingObservedByName.set(toolName, remaining - 1);
		} else {
			unmatchedStepToolNames.push(toolName);
		}
	}
	const hasNamedStepExecutionEvidence = unmatchedStepToolNames.some(
		(toolName) =>
			toolName !== "tedix_mcp_code" &&
			classifyToolCall(toolName, "{}") === "execution",
	);
	const anonymousStepShortfall = Math.max(
		0,
		stepToolCallCount - stepToolNames.length,
	);
	const hasUnclassifiedToolCall =
		anonymousStepShortfall > 0 ||
		unmatchedStepToolNames.includes("tedix_mcp_code") ||
		missingExecutionReceipt;

	return {
		toolCallCount: Math.max(toolCalls.length, stepToolCallCount),
		hasExecutionEvidence:
			realArtifact ||
			hasExecutionEvidence(toolCalls) ||
			hasNamedStepExecutionEvidence,
		hasTerminalExecutionEvidence: terminalExecutionEvidence,
		hasUnclassifiedToolCall,
	};
}
