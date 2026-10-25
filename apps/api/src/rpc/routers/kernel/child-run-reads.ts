/**
 * Kernel — delegated child-run evidence and combined readers.
 * This module must NOT import kernel-runtime.ts: the router imports this module.
 */

import { safeExceptionTopology } from "../../../lib/safe-log-metadata";
import {
	getChatDispatchMappingByIdempotencyKey,
	listTediArtifacts,
	listTediRuntimeEvents,
	type TediArtifactRow,
	type TediRuntimeEventRow,
} from "@tedix/db/queries/kernel-runtime-events";
import type { BaseContext } from "../../orpc";
import {
	classifyDelegatedStop,
	declaredDelegationOutcome,
	type DeclaredDelegationOutcome,
	type DelegatedStopClassification,
	isStructuredDelegatedStopReason,
} from "./delegated-stop";
import {
	errorMessage,
	isRemoteD1TransportError,
	nonNullRecord,
	shouldFailSoftChildEvidenceRead,
	stringFromPayload,
} from "./runtime-shared";
import {
	isToolErrorString,
	latestFinalAssistantContent,
	summarizeChildRuntimeEvents,
} from "./child-run-events";
import {
	type ChildRunLiveness,
	computeChildRunLiveness,
} from "./child-run-liveness";
import {
	type ChildRunFinalAssistantResult,
	delegatedWidgetProjectionFromEvents,
	FINAL_ASSISTANT_MESSAGE_CHAR_CAP,
} from "./child-run-delegated-result";

export type ChildRunEvidenceRows = {
	artifactRows: TediArtifactRow[];
	eventRows: TediRuntimeEventRow[];
	observedRunIds: string[];
};

/**
 * Extra attempts (beyond the first) for a TRANSIENT remote-D1 transport error.
 * Evidence rows for a delegated run are correctly keyed by the stored
 * childRunId (verified against production D1 for the
 * `{tediId}:mcp:{homeRunId}_auto_{tediId}` auto-dispatch shape) — when a read
 * comes back empty-with-error it is a transport flake, not missing data, so a
 * bounded in-request retry heals it instead of rendering "No evidence yet"
 * over a fully-populated ledger.
 */
const TRANSIENT_D1_RETRY_ATTEMPTS = 2;

async function withTransientD1Retry<T>(read: () => Promise<T>): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt <= TRANSIENT_D1_RETRY_ATTEMPTS; attempt += 1) {
		try {
			return await read();
		} catch (error) {
			if (!isRemoteD1TransportError(error)) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

async function readMappedWorkstationRunIds(
	context: BaseContext,
	ref: { runId: string; tediId: string },
): Promise<string[]> {
	try {
		const mapping = await withTransientD1Retry(() =>
			getChatDispatchMappingByIdempotencyKey(context.db, ref.runId),
		);
		const mappedRunId = mapping?.runId;
		if (!mappedRunId || mappedRunId === ref.runId) return [];
		return [mappedRunId];
	} catch (error) {
		// Fail-soft: a transport flake on the OPTIONAL workstation mapping must
		// not sink the whole evidence read — the primary childRunId query still
		// runs. Non-transient errors propagate.
		if (!shouldFailSoftChildEvidenceRead(error)) throw error;
		console.warn("[kernelRuntime] workstation run-id mapping read failed", {
			error: errorMessage(error),
			runId: ref.runId,
			tediId: ref.tediId,
		});
		return [];
	}
}

async function resolveObservedChildRunIds(
	context: BaseContext,
	ref: {
		includeMappedWorkstationRun?: boolean;
		runId: string;
		tediId: string;
	},
): Promise<string[]> {
	const ids = [ref.runId];
	if (ref.includeMappedWorkstationRun) {
		for (const mappedRunId of await readMappedWorkstationRunIds(context, ref)) {
			if (!ids.includes(mappedRunId)) ids.push(mappedRunId);
		}
	}
	return ids;
}

export async function readChildRunEvidenceRows(
	context: BaseContext,
	input: {
		artifactLimit: number;
		eventLimit: number;
		includeMappedWorkstationRun?: boolean;
		// When provided, a separate query fetches workstation.egress.* events
		// recorded under the kernel run ID (which differs from childRunId).
		kernelRunId?: string;
		organizationId?: string;
		runId: string;
		tediId: string;
	},
): Promise<ChildRunEvidenceRows & { eventReadAvailable: boolean }> {
	const observedRunIds = await resolveObservedChildRunIds(context, {
		includeMappedWorkstationRun: input.includeMappedWorkstationRun,
		runId: input.runId,
		tediId: input.tediId,
	});
	let eventReadAvailable = true;
	const readEventRows = (async () => {
		try {
			const rows = await withTransientD1Retry(() =>
				listTediRuntimeEvents(context.db, {
					organizationId: input.organizationId,
					tediId: input.tediId,
					runIds: observedRunIds,
					order: "desc",
					limit: input.eventLimit,
				}),
			);
			// Late tool events can push a terminal receipt out of the activity page.
			const terminalKinds = [
				"run.completed",
				"run.failed",
				"run.canceled",
			] as const;
			if (
				input.eventLimit > 0 &&
				rows.length >= input.eventLimit &&
				!rows.some((row) => terminalKinds.some((kind) => kind === row.kind))
			) {
				const terminalRows = await withTransientD1Retry(() =>
					listTediRuntimeEvents(context.db, {
						organizationId: input.organizationId,
						tediId: input.tediId,
						runIds: observedRunIds,
						kinds: terminalKinds,
						order: "desc",
						limit: 1,
					}),
				);
				return [...rows, ...terminalRows].sort((a, b) =>
					b.createdAt.localeCompare(a.createdAt),
				);
			}
			return rows;
		} catch (error) {
			if (!shouldFailSoftChildEvidenceRead(error)) throw error;
			eventReadAvailable = false;
			console.warn("[kernelRuntime] child runtime event evidence read failed", {
				error: errorMessage(error),
				organizationId: input.organizationId,
				runIds: observedRunIds,
				tediId: input.tediId,
			});
			return [] as TediRuntimeEventRow[];
		}
	})();
	// Egress events are recorded with runId = kernelRunId (the kernel delegation
	// row PK), not childRunId, so they are invisible to the inArray query above.
	// Fetch them separately and merge so denied egress attempts surface as evidence.
	// Egress kind values recorded by tedi-workstation-runtime (cognitive-runtime schema).
	const WORKSTATION_EGRESS_KINDS = [
		"workstation.egress.allow",
		"workstation.egress.deny",
	] as const;
	const kernelRunId = input.kernelRunId;
	const readEgressRows = kernelRunId
		? (async () => {
				try {
					return await withTransientD1Retry(() =>
						listTediRuntimeEvents(context.db, {
							organizationId: input.organizationId,
							tediId: input.tediId,
							runId: kernelRunId,
							kinds: WORKSTATION_EGRESS_KINDS,
							order: "desc",
							limit: input.eventLimit,
						}),
					);
				} catch (error) {
					console.warn(
						"[kernelRuntime] workstation egress event evidence read failed",
						{
							error: errorMessage(error),
							kernelRunId,
							organizationId: input.organizationId,
							tediId: input.tediId,
						},
					);
					return [] as TediRuntimeEventRow[];
				}
			})()
		: Promise.resolve([] as TediRuntimeEventRow[]);
	const readArtifactRows =
		input.artifactLimit > 0
			? (async () => {
					try {
						return await withTransientD1Retry(() =>
							listTediArtifacts(context.db, {
								organizationId: input.organizationId,
								tediId: input.tediId,
								runIds: observedRunIds,
								limit: input.artifactLimit,
							}),
						);
					} catch (error) {
						console.warn(
							"[kernelRuntime] child artifact evidence read failed",
							{
								error: errorMessage(error),
								organizationId: input.organizationId,
								runIds: observedRunIds,
								tediId: input.tediId,
							},
						);
						return [] as TediArtifactRow[];
					}
				})()
			: Promise.resolve([] as TediArtifactRow[]);
	const [eventRows, egressRows, artifactRows] = await Promise.all([
		readEventRows,
		readEgressRows,
		readArtifactRows,
	]);
	// Merge egress events into the main event list, dedup by id, keep DESC order.
	type EventRow = TediRuntimeEventRow;
	let mergedEventRows: EventRow[] = eventRows;
	if (egressRows.length > 0) {
		const seenIds = new Set(eventRows.map((r: EventRow) => r.id));
		const newEgressRows = egressRows.filter(
			(r: EventRow) => !seenIds.has(r.id),
		);
		if (newEgressRows.length > 0) {
			mergedEventRows = [...eventRows, ...newEgressRows].sort(
				(a: EventRow, b: EventRow) =>
					(b.createdAt ?? "").localeCompare(a.createdAt ?? ""),
			);
		}
	}
	return {
		artifactRows,
		eventRows: mergedEventRows,
		observedRunIds,
		eventReadAvailable,
	};
}

/**
 * Read and summarize the child runtime events for a single delegation child run.
 * Returns the `summarizeChildRuntimeEvents` summary (which includes
 * `childRunStatus`, `childRunPreview`, etc.) or null when no events exist or the
 * read fails. Used by the crash-lease sweep in `reconcileStaleSubmissions` to
 * identify fresh child activity and substantive completion before crash-failing
 * a silent delegation parent. The sweep supplies its organization constraint.
 */
export async function readSingleChildRunSummary(
	context: BaseContext,
	ref: { organizationId?: string; tediId: string; runId: string },
): Promise<Record<string, unknown> | null> {
	try {
		const { eventRows } = await readChildRunEvidenceRows(context, {
			artifactLimit: 0,
			eventLimit: 25,
			// Include the mapped workstation run. A workstation child's
			// `...:workstation:...` run-id carries no events itself — they live under
			// the mapped run-id (chatDispatchIdempotency). Without this the
			// crash-lease self-heal is blind to workstation delegations (the exact
			// firecrawl/750ee463 cohort) and falls through to crash-fail. Mirrors
			// the on-read reconciler (readChildRunStatusesForRunRows, which passes
			// the run's workstationDispatch flag) so the sweep recovers BOTH paths.
			includeMappedWorkstationRun: true,
			organizationId: ref.organizationId,
			runId: ref.runId,
			tediId: ref.tediId,
		});
		return summarizeChildRuntimeEvents(eventRows);
	} catch (error) {
		console.warn("[kernelRuntime] readSingleChildRunSummary failed", {
			exception: safeExceptionTopology(error),
			runId: ref.runId,
			tediId: ref.tediId,
		});
		return null;
	}
}

/**
 * Hard char budget for the assembled full-result transcript passed to the
 * synthesis LLM — matches the L0 flat-cap so no single delegation can exceed
 * the context window.
 */
const DELEGATION_RESULT_CHAR_BUDGET = 24_576;

/**
 * Read the FULL result transcript for a single completed child delegation run.
 * Assembles an ORDERED, chronological transcript from:
 *   - `message.completed` payload.content (full, no char cap)
 *   - Structured `tool.completed` payloads (data ?? result, errors skipped)
 *   - Artifact titles/refs
 * Hard-capped at {@link DELEGATION_RESULT_CHAR_BUDGET} (24 576 chars).
 * Fail-soft: read errors → null (never throws).
 *
 * Exported for injection into {@link KernelTurnWorkDeps.readChildRunFullResult}.
 */
export async function readChildRunFullResult(
	context: BaseContext,
	input: {
		tediId: string;
		runId: string;
		organizationId: string;
		eventLimit?: number;
		artifactLimit?: number;
		includeMappedWorkstationRun?: boolean;
	},
): Promise<string | null> {
	return (await readChildRunResultAndLiveness(context, input)).transcript;
}

/**
 * Read BOTH the full transcript AND the {@link ChildRunLiveness} from ONE event
 * ledger query. Liveness describes observed execution separately from the task
 * outcome; the transcript-only {@link readChildRunFullResult} wraps
 * this and drops the liveness for callers that don't need it.
 */
export async function readChildRunResultAndLiveness(
	context: BaseContext,
	input: {
		tediId: string;
		runId: string;
		organizationId: string;
		eventLimit?: number;
		artifactLimit?: number;
		includeMappedWorkstationRun?: boolean;
		/** The parent work order's verify command; a success without `Verification output:` is partial. */
		verifyCommand?: string | null;
	},
): Promise<{
	transcript: string | null;
	liveness: ChildRunLiveness | null;
	/** Structured runtime stop reason from `run.completed`, or null. */
	stopReason: string | null;
	/** Full stop classification (partial vs no-output failed), or null. */
	stop: DelegatedStopClassification | null;
	declaredOutcome: DeclaredDelegationOutcome | null;
	/** False only when the authoritative child ledger could not be read. */
	readAvailable: boolean;
}> {
	try {
		let { eventRows, artifactRows, eventReadAvailable, observedRunIds } =
			await readChildRunEvidenceRows(context, {
				tediId: input.tediId,
				runId: input.runId,
				organizationId: input.organizationId,
				eventLimit: input.eventLimit ?? 120,
				artifactLimit: input.artifactLimit ?? 8,
				includeMappedWorkstationRun:
					input.includeMappedWorkstationRun ??
					input.runId.includes(":workstation:"),
			});

		// Later tool/transport events can evict the final answer from the mixed window.
		// Recover it through the existing kind-filtered ledger query, bounded to one page.
		if (eventReadAvailable && latestFinalAssistantContent(eventRows) === null) {
			const finalRows = await withTransientD1Retry(() =>
				listTediRuntimeEvents(context.db, {
					organizationId: input.organizationId,
					tediId: input.tediId,
					runIds: observedRunIds,
					kinds: ["message.completed"],
					order: "desc",
					limit: 16,
				}),
			);
			if (latestFinalAssistantContent(finalRows) === null) {
				throw new Error(
					"Latest final assistant result is unavailable in the bounded child ledger read",
				);
			}
			const seen = new Set(eventRows.map((row) => row.id));
			eventRows = [
				...eventRows,
				...finalRows.filter((row) => !seen.has(row.id)),
			].sort(
				(a, b) =>
					b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
			);
		}

		const liveness = computeChildRunLiveness(eventRows);
		const completedPayload = nonNullRecord(
			eventRows.find((row) => row.kind === "run.completed")?.payload,
		);
		const structuredStopReason =
			stringFromPayload(completedPayload?.stopReason) ?? null;
		const stopReason = isStructuredDelegatedStopReason(structuredStopReason)
			? structuredStopReason
			: null;
		const priorityParts: string[] = [];
		if (stopReason) {
			priorityParts.push(
				`[partial-result]\nstopReason=${stopReason}; continuation and fresh verification are required.`,
			);
		}

		const assistantParts: string[] = [];
		const finalAssistantContent = latestFinalAssistantContent(eventRows);
		for (const row of eventRows) {
			if (row.kind !== "message.completed") continue;
			const payload = nonNullRecord(row.payload);
			if (payload?.role !== undefined && payload.role !== "assistant") continue;
			const content =
				typeof payload?.content === "string" ? payload.content.trim() : "";
			if (content) {
				const bounded =
					content.length > FINAL_ASSISTANT_MESSAGE_CHAR_CAP
						? `${content.slice(0, FINAL_ASSISTANT_MESSAGE_CHAR_CAP)}\n[assistant result truncated]`
						: content;
				assistantParts.push(`[assistant]\n${bounded}`);
			}
		}
		if (assistantParts[0]) priorityParts.push(assistantParts[0]);
		const stop = classifyDelegatedStop({
			assistantText: finalAssistantContent,
			structuredStopReason,
			verifyCommand: input.verifyCommand ?? null,
		});

		for (const artifact of artifactRows.slice(0, 8)) {
			const artifactLabel = artifact.name.trim()
				? artifact.name.trim()
				: (artifact.kind ?? "artifact");
			priorityParts.push(`[artifact:${artifactLabel}]\nid=${artifact.id}`);
		}

		const toolParts: string[] = [];
		// eventRows are DESC-ordered: newest evidence first. Bound each payload so
		// one discovery catalog cannot consume the entire synthesis transcript.
		for (const row of eventRows) {
			if (row.kind === "tool.completed") {
				const payload = nonNullRecord(row.payload);
				const name = typeof payload?.name === "string" ? payload.name : "tool";
				const data = payload?.data ?? payload?.result;
				if (data !== undefined && data !== null) {
					const dataStr =
						typeof data === "string" ? data : JSON.stringify(data);
					if (dataStr && !isToolErrorString(dataStr)) {
						const bounded =
							dataStr.length > 4_096
								? `${dataStr.slice(0, 4_096)}\n[tool result truncated]`
								: dataStr;
						toolParts.push(`[tool:${name}]\n${bounded}`);
					}
				}
			}
		}
		for (const priorAssistant of assistantParts.slice(1)) {
			toolParts.push(priorAssistant);
		}
		const selected: string[] = [];
		let used = 0;
		for (const part of [...priorityParts, ...toolParts]) {
			const separator = selected.length > 0 ? 2 : 0;
			if (used + separator + part.length > DELEGATION_RESULT_CHAR_BUDGET) {
				continue;
			}
			selected.push(part);
			used += separator + part.length;
		}
		return {
			transcript: selected.length > 0 ? selected.join("\n\n") : null,
			liveness,
			stopReason,
			stop,
			declaredOutcome: declaredDelegationOutcome(finalAssistantContent),
			readAvailable: eventReadAvailable,
		};
	} catch (error) {
		console.warn("[kernelRuntime] readChildRunResultAndLiveness failed", {
			error: errorMessage(error),
			tediId: input.tediId,
			runId: input.runId,
		});
		// Failed observation supplies neither a task declaration nor execution telemetry.
		return {
			transcript: null,
			liveness: null,
			stopReason: null,
			stop: null,
			declaredOutcome: null,
			readAvailable: false,
		};
	}
}

/**
 * Read ONLY the child's final assistant message (the latest `message.completed`
 * content). Non-LLM fallback for the delegation completion message when
 * synthesis is disabled or fails — the operator should see the tedi's own
 * closing answer, not a rolling activity preview. Fail-soft: null on error.
 */
export async function readChildRunFinalAssistantMessage(
	context: BaseContext,
	input: { tediId: string; runId: string; organizationId: string },
): Promise<string | null> {
	return (await readChildRunFinalAssistantResult(context, input)).content;
}

/** Read the final answer together with the explicitly bounded MCP UI projection. */
export async function readChildRunFinalAssistantResult(
	context: BaseContext,
	input: { tediId: string; runId: string; organizationId: string },
): Promise<ChildRunFinalAssistantResult> {
	try {
		const { eventRows } = await readChildRunEvidenceRows(context, {
			tediId: input.tediId,
			runId: input.runId,
			organizationId: input.organizationId,
			eventLimit: 120,
			artifactLimit: 0,
			includeMappedWorkstationRun: input.runId.includes(":workstation:"),
		});
		const widgets = delegatedWidgetProjectionFromEvents(eventRows);
		// eventRows are DESC-ordered: the first assistant message.completed is final.
		for (const row of eventRows) {
			if (row.kind !== "message.completed") continue;
			const payload = nonNullRecord(row.payload);
			if (payload?.role !== undefined && payload.role !== "assistant") continue;
			const content =
				typeof payload?.content === "string" ? payload.content.trim() : "";
			if (!content) continue;
			return {
				content:
					content.length > FINAL_ASSISTANT_MESSAGE_CHAR_CAP
						? content.slice(0, FINAL_ASSISTANT_MESSAGE_CHAR_CAP)
						: content,
				widgets,
			};
		}
		return { content: null, widgets };
	} catch (error) {
		console.warn("[kernelRuntime] readChildRunFinalAssistantResult failed", {
			error: errorMessage(error),
			tediId: input.tediId,
			runId: input.runId,
		});
		return { content: null, widgets: [] };
	}
}
